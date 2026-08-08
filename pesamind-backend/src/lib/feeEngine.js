const crypto = require("crypto");
const prisma = require("./prisma");
const { badRequest, notFound } = require("./errors");

const QUOTE_TTL_MS = 5 * 60 * 1000; // configurable-in-spirit; see docs/FEE_ENGINE.md for how to make this a real setting

/* ---------------------------------------------------------------------- *
 * Fee model computation — pure functions, no DB access, easy to unit test.
 * ---------------------------------------------------------------------- */

function applyCap(fee, minFee, maxFee) {
  let f = fee;
  if (minFee !== null && minFee !== undefined) f = Math.max(f, Number(minFee));
  if (maxFee !== null && maxFee !== undefined) f = Math.min(f, Number(maxFee));
  return Math.max(0, Math.round(f * 100) / 100);
}

function resolveTier(tiers, amount) {
  return tiers.find((t) => amount >= Number(t.minAmount) && (t.maxAmount === null || amount <= Number(t.maxAmount)));
}

/**
 * Computes the raw fee for one FeeRule (or one FeeTier, which shares the
 * same fixed/percentage/model shape) against a transaction amount.
 */
function computeRuleFee(rule, amount) {
  switch (rule.feeModel) {
    case "zero":
    case "display_only":
      return 0;
    case "fixed":
      return applyCap(Number(rule.fixedAmount || 0), rule.minFee, rule.maxFee);
    case "percentage":
      return applyCap(amount * (Number(rule.percentage || 0) / 100), rule.minFee, rule.maxFee);
    case "fixed_plus_percentage":
      return applyCap(Number(rule.fixedAmount || 0) + amount * (Number(rule.percentage || 0) / 100), rule.minFee, rule.maxFee);
    case "tiered": {
      const tier = resolveTier(rule.tiers || [], amount);
      if (!tier) return 0; // a gap in tier coverage — validateTiers() should prevent this at save time
      const tierFee = tier.feeModel === "percentage" ? amount * (Number(tier.percentage || 0) / 100) : Number(tier.fixedAmount || 0);
      return applyCap(tierFee, rule.minFee, rule.maxFee);
    }
    default:
      return 0;
  }
}

/**
 * Rejects overlapping, gapped, or invalid tiers before a rule is saved.
 * Tiers must be contiguous starting at 0, non-overlapping, and the last
 * tier's maxAmount must be null (unbounded).
 */
function validateTiers(tiers) {
  if (!tiers.length) throw badRequest("A tiered fee rule needs at least one tier");
  const sorted = [...tiers].sort((a, b) => Number(a.minAmount) - Number(b.minAmount));
  if (Number(sorted[0].minAmount) !== 0) throw badRequest("The first tier must start at 0");
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (Number(t.minAmount) < 0) throw badRequest("Tier amounts can't be negative");
    if (t.maxAmount !== null && t.maxAmount !== undefined && Number(t.maxAmount) < Number(t.minAmount)) {
      throw badRequest("A tier's maximum can't be below its minimum");
    }
    if (t.feeModel === "fixed" && Number(t.fixedAmount) < 0) throw badRequest("Tier fees can't be negative");
    if (t.feeModel === "percentage" && Number(t.percentage) < 0) throw badRequest("Tier fees can't be negative");
    if (i < sorted.length - 1) {
      const next = sorted[i + 1];
      if (t.maxAmount === null || t.maxAmount === undefined) throw badRequest("Only the last tier may be unbounded (no maximum)");
      // Tolerance of 1: the natural pattern for whole-currency bands is
      // "0–10,000" then "10,001–50,000" (an off-by-one boundary, exactly
      // the spec's own example) — that's contiguous, not a gap.
      if (Number(next.minAmount) - Number(t.maxAmount) > 1.01) throw badRequest(`Gap between tiers: ${t.maxAmount} to ${next.minAmount} isn't covered`);
      if (Number(t.maxAmount) >= Number(next.minAmount)) throw badRequest(`Tiers overlap around ${next.minAmount}`);
    } else if (t.maxAmount !== null && t.maxAmount !== undefined) {
      throw badRequest("The last tier must be unbounded (no maximum)");
    }
  }
}

/* ---------------------------------------------------------------------- *
 * Rule matching — finds the best-fit ACTIVE rule for a given context.
 * ---------------------------------------------------------------------- */

function startOfDay(d) {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function ruleMatches(rule, ctx, now) {
  if (rule.status !== "ACTIVE") return false;
  // Compared at day granularity — a rule effective "today" should apply
  // for the whole day regardless of the exact hour, and regardless of any
  // gap between the admin's local timezone (e.g. EAT, UTC+3) and the
  // server's clock (UTC). Exact-instant comparison here previously made a
  // same-day rule intermittently look "not yet started."
  if (startOfDay(rule.effectiveFrom) > startOfDay(now)) return false;
  if (rule.effectiveTo && startOfDay(rule.effectiveTo) < startOfDay(now)) return false;
  if (rule.minAmount !== null && ctx.amount < Number(rule.minAmount)) return false;
  if (rule.maxAmount !== null && ctx.amount > Number(rule.maxAmount)) return false;
  if (rule.channel && rule.channel !== ctx.channel) return false;
  if (rule.onUsOffUs && rule.onUsOffUs !== ctx.onUsOffUs) return false;
  if (rule.customerSegment && rule.customerSegment !== ctx.customerSegment) return false;
  if (rule.accountType && rule.accountType !== ctx.accountType) return false;
  if (rule.merchantCategory && rule.merchantCategory !== ctx.merchantCategory) return false;
  if (rule.currency && ctx.currency && rule.currency !== ctx.currency) return false;
  if (rule.customerId && rule.customerId !== ctx.userId) return false;
  return true;
}

function specificity(rule) {
  // How many optional dimensions this rule pins down — more specific rules
  // win over general ones at equal priority.
  return ["minAmount", "maxAmount", "channel", "onUsOffUs", "customerSegment", "accountType", "merchantCategory", "customerId"]
    .filter((k) => rule[k] !== null && rule[k] !== undefined).length;
}

async function findBestRule(transactionTypeId, ctx, now) {
  const candidates = await prisma.feeRule.findMany({
    where: { transactionTypeId, status: "ACTIVE" },
    include: { tiers: { orderBy: { sortOrder: "asc" } } },
  });
  const matching = candidates.filter((r) => ruleMatches(r, ctx, now));
  if (!matching.length) return null;
  // Individual-customer exceptions and campaign rules should naturally win
  // via higher specificity; ties broken by priority (lower wins), then most
  // recently created.
  matching.sort((a, b) => specificity(b) - specificity(a) || a.priority - b.priority || b.createdAt - a.createdAt);
  return matching[0];
}

/* ---------------------------------------------------------------------- *
 * Bundle + exemption lookups
 * ---------------------------------------------------------------------- */

async function findActiveExemption(userId, transactionTypeId, now) {
  return prisma.feeExemption.findFirst({
    where: {
      userId,
      isActive: true,
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gte: now } }],
      AND: [{ OR: [{ transactionTypeId: null }, { transactionTypeId }] }],
    },
    orderBy: { transactionTypeId: "asc" }, // prefer a type-specific exemption over a blanket one when both exist
  });
}

async function findActiveBundle(userId, transactionTypeId, amount, now) {
  const subs = await prisma.customerBundleSubscription.findMany({
    where: { userId, status: "ACTIVE", expiresAt: { gte: now } },
    include: { bundle: true },
  });
  for (const sub of subs) {
    const included = Array.isArray(sub.bundle.includedTransactionTypeIds) ? sub.bundle.includedTransactionTypeIds : [];
    if (!included.includes(transactionTypeId)) continue;
    if (sub.bundle.maxTransactionValue && amount > Number(sub.bundle.maxTransactionValue)) continue;
    if (sub.bundle.includedTransactionCount !== null && sub.transactionsUsed >= sub.bundle.includedTransactionCount) continue;
    if (sub.bundle.fairUsageLimit !== null && sub.transactionsUsed >= sub.bundle.fairUsageLimit) continue;
    return sub;
  }
  return null;
}

/* ---------------------------------------------------------------------- *
 * The public API — quoteFee() and collectFee()
 * ---------------------------------------------------------------------- */

/**
 * The reusable calculation service described in the spec's Section 10.
 * Implements the pricing priority chain:
 *   1. Regulatory/mandatory exemption + 2. customer-specific waiver
 *      (both modeled as FeeExemption — see docs/FEE_ENGINE.md)
 *   3. Active promotional rule (a FeeRule with campaignName set)
 *   4. Active bundle entitlement
 *   5. Applicable standard or tiered fee (best-matching FeeRule)
 *   6. Default fallback (zero — see docs/FEE_ENGINE.md "Assumptions")
 *
 * @param {object} ctx - { userId, transactionTypeCode, amount, currency,
 *   channel, onUsOffUs, customerSegment, accountType, merchantCategory,
 *   partnerFee (already-known, e.g. an institution markup — never
 *   recomputed here, only carried through and disclosed) }
 */
async function quoteFee(ctx) {
  const now = new Date();
  const type = await prisma.feeTransactionType.findUnique({ where: { code: ctx.transactionTypeCode } });

  const partnerFee = Number(ctx.partnerFee || 0);
  const base = { userId: ctx.userId, transactionTypeCode: ctx.transactionTypeCode, amount: ctx.amount, currency: ctx.currency || "TZS", context: ctx };

  const finalize = async (fields) => {
    const totalFee = Number(fields.pesaMindFee) + partnerFee + Number(fields.tax || 0) - Number(fields.discount || 0) - Number(fields.bundleBenefit || 0);
    const quote = await prisma.feeQuote.create({
      data: {
        ...base,
        pesaMindFee: fields.pesaMindFee,
        partnerFee,
        tax: fields.tax || 0,
        discount: fields.discount || 0,
        bundleBenefit: fields.bundleBenefit || 0,
        totalFee: Math.max(0, totalFee),
        totalDebit: Number(ctx.amount) + Math.max(0, totalFee),
        feeRuleId: fields.feeRuleId || null,
        feeRuleVersion: fields.feeRuleVersion || null,
        bundleSubscriptionId: fields.bundleSubscriptionId || null,
        exemptionId: fields.exemptionId || null,
        disclosureEn: fields.disclosureEn,
        disclosureSw: fields.disclosureSw,
        expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
      },
    });
    return quote;
  };

  // Not a monetizable type at all (or not yet registered) — free, no rule needed.
  if (!type || !type.isMonetizable || !type.isActive) {
    return finalize({
      pesaMindFee: 0,
      disclosureEn: partnerFee > 0 ? `No PesaMind fee. A partner charge of ${partnerFee.toLocaleString()} TZS applies.` : "This is a free PesaMind feature.",
      disclosureSw: partnerFee > 0 ? `Hakuna ada ya PesaMind. Ada ya mshirika ya TZS ${partnerFee.toLocaleString()} inatumika.` : "Hii ni huduma ya bure ya PesaMind.",
    });
  }

  // Priority 1+2: exemption / waiver
  const exemption = await findActiveExemption(ctx.userId, type.id, now);
  if (exemption) {
    return finalize({
      pesaMindFee: 0,
      exemptionId: exemption.id,
      disclosureEn: `Fee waived: ${exemption.reason}.`,
      disclosureSw: `Ada imesamehewa: ${exemption.reason}.`,
    });
  }

  // Priority 4: active bundle (checked before the standard rule lookup —
  // priority 3's "active promotional rule" is just a FeeRule with a
  // campaignName, so it's naturally picked up by findBestRule below and
  // wins there via higher specificity/priority; the bundle check sits
  // between exemptions and the standard-rule fallback per the spec order)
  const bundleSub = await findActiveBundle(ctx.userId, type.id, ctx.amount, now);
  if (bundleSub) {
    return finalize({
      pesaMindFee: 0,
      bundleBenefit: 0, // the benefit IS the waived fee — nothing to net off since no fee was computed
      bundleSubscriptionId: bundleSub.id,
      disclosureEn: `Covered by your ${bundleSub.bundle.nameEn} bundle.`,
      disclosureSw: `Imefunikwa na kifurushi chako cha ${bundleSub.bundle.nameSw}.`,
    });
  }

  // Priority 3 (promotional) and 5 (standard/tiered) both resolve here —
  // a promotional rule is just a FeeRule with a campaignName and higher
  // specificity/priority, so it wins the match naturally.
  const rule = await findBestRule(type.id, {
    amount: ctx.amount, channel: ctx.channel, onUsOffUs: ctx.onUsOffUs, customerSegment: ctx.customerSegment,
    accountType: ctx.accountType, merchantCategory: ctx.merchantCategory, currency: ctx.currency, userId: ctx.userId,
  }, now);

  if (!rule) {
    // Priority 6: default fallback. See docs/FEE_ENGINE.md — undercharging
    // (zero) is the deliberate safe default over blocking an otherwise-
    // working transaction that simply hasn't been priced yet.
    return finalize({
      pesaMindFee: 0,
      disclosureEn: partnerFee > 0 ? `No PesaMind fee configured yet. A partner charge of ${partnerFee.toLocaleString()} TZS applies.` : "No fee currently applies to this transaction.",
      disclosureSw: partnerFee > 0 ? `Hakuna ada ya PesaMind iliyowekwa bado. Ada ya mshirika ya TZS ${partnerFee.toLocaleString()} inatumika.` : "Hakuna ada inayotumika kwa muamala huu kwa sasa.",
    });
  }

  const pesaMindFee = rule.feeModel === "display_only" ? 0 : computeRuleFee(rule, ctx.amount);
  const displayOnlyPartnerFee = rule.feeModel === "display_only" ? computeRuleFee(rule, ctx.amount) : 0;
  let tax = 0;
  if (rule.taxTreatment === "VAT_EXCLUSIVE") tax = pesaMindFee * (Number(rule.vatRate) / 100);
  // VAT_INCLUSIVE: the configured fee already includes VAT — tax is disclosed as a component, not added on top.
  const vatComponent = rule.taxTreatment === "VAT_INCLUSIVE" ? pesaMindFee - pesaMindFee / (1 + Number(rule.vatRate) / 100) : tax;

  const enDesc = rule.descriptionEn || `${rule.name} applies to this transaction.`;
  const swDesc = rule.descriptionSw || `Ada ya ${rule.name} inatumika kwa muamala huu.`;

  return finalize({
    pesaMindFee,
    partnerFee: partnerFee + displayOnlyPartnerFee,
    tax: vatComponent,
    feeRuleId: rule.id,
    feeRuleVersion: rule.version,
    disclosureEn: enDesc,
    disclosureSw: swDesc,
  });
}

/**
 * Finalizes a quote against a completed transaction — idempotent: calling
 * this twice with the same quoteId simply returns the existing record
 * rather than double-collecting. Must be called before (or atomically
 * with) marking the underlying transaction complete, and the quote must
 * not have expired.
 */
async function collectFee(quoteId, transactionRef) {
  const existing = await prisma.feeCollectionRecord.findUnique({ where: { quoteId } });
  if (existing) return existing; // idempotent — already collected for this quote

  const quote = await prisma.feeQuote.findUnique({ where: { id: quoteId } });
  if (!quote) throw notFound("Fee quote not found");
  if (quote.consumedAt) throw badRequest("This fee quote has already been used");
  if (quote.expiresAt < new Date()) throw badRequest("This fee quote has expired — please try again");

  await prisma.feeQuote.update({ where: { id: quoteId }, data: { consumedAt: new Date() } });

  const record = await prisma.feeCollectionRecord.create({
    data: {
      quoteId,
      transactionRef,
      transactionTypeCode: quote.transactionTypeCode,
      userId: quote.userId,
      pesaMindFeeCollected: quote.pesaMindFee,
      partnerFeeDisclosed: quote.partnerFee,
      taxCollected: quote.tax,
    },
  });

  if (quote.bundleSubscriptionId) {
    await prisma.customerBundleSubscription.update({
      where: { id: quote.bundleSubscriptionId },
      data: { transactionsUsed: { increment: 1 } },
    });
  }

  return record;
}

/**
 * Reverses a previously collected fee — full or partial. Called alongside
 * (not instead of) reversing the underlying transaction itself.
 */
async function reverseFee(transactionRef, amount /* null = full reversal */) {
  const record = await prisma.feeCollectionRecord.findFirst({ where: { transactionRef, status: { in: ["COLLECTED", "PARTIALLY_REVERSED"] } } });
  if (!record) return null;
  const already = Number(record.reversedAmount);
  const collected = Number(record.pesaMindFeeCollected);
  const toReverse = amount === null || amount === undefined ? collected - already : Math.min(amount, collected - already);
  const newReversed = already + toReverse;
  return prisma.feeCollectionRecord.update({
    where: { id: record.id },
    data: { reversedAmount: newReversed, reversedAt: new Date(), status: newReversed >= collected ? "REVERSED" : "PARTIALLY_REVERSED" },
  });
}

/**
 * Non-persisting lookup for display purposes when the amount isn't known
 * yet (the customer hasn't entered one) — returns the raw matching rule's
 * fee-model fields so the frontend can mirror the calculation live as they
 * type, the same pattern used for partner/institution fee previews. The
 * real, authoritative quote is always computed by quoteFee() once an
 * amount exists, whether that's at resolve time (fixed-amount QR) or pay
 * time (customer-entered amount).
 */
async function previewFeeRule(transactionTypeCode, ctx) {
  const type = await prisma.feeTransactionType.findUnique({ where: { code: transactionTypeCode } });
  if (!type || !type.isMonetizable || !type.isActive) return null;
  const now = new Date();
  // Passing amount=0 means a rule that's itself amount-banded via
  // minAmount (rather than using tiers) might not match here even though
  // the customer's eventual real amount would — a known limitation of
  // previewing before an amount exists. quoteFee() at actual pay time is
  // always authoritative regardless of what this preview showed.
  const rule = await findBestRule(type.id, { amount: 0, ...ctx }, now);
  if (!rule) return null;
  return {
    feeModel: rule.feeModel,
    fixedAmount: rule.fixedAmount !== null ? Number(rule.fixedAmount) : null,
    percentage: rule.percentage !== null ? Number(rule.percentage) : null,
    minFee: rule.minFee !== null ? Number(rule.minFee) : null,
    maxFee: rule.maxFee !== null ? Number(rule.maxFee) : null,
    tiers: (rule.tiers || []).map((t) => ({
      minAmount: Number(t.minAmount), maxAmount: t.maxAmount !== null ? Number(t.maxAmount) : null,
      feeModel: t.feeModel, fixedAmount: t.fixedAmount !== null ? Number(t.fixedAmount) : null, percentage: t.percentage !== null ? Number(t.percentage) : null,
    })),
  };
}

module.exports = { quoteFee, collectFee, reverseFee, previewFeeRule, computeRuleFee, validateTiers, QUOTE_TTL_MS };

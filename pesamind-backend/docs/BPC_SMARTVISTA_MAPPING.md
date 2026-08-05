# BPC SmartVista — CMS integration mapping

This documents how PesaMind's card-issuing provider abstraction maps onto
BPC SmartVista's real, documented API surface (SmartVista Webgate
specification guide — "SVWG", and the SVAP issuing file/web-service
structure guide — "SVAP"), so the eventual real connection is a swap of
`src/services/card-issuing/BpcSmartVistaSimProvider.js` for a real
`BpcSmartVistaProvider.js` implementing the same `CardIssuingProvider`
interface — not a redesign of anything else in the app.

## Operation mapping

| Our provider method | Real BPC operation | Source |
|---|---|---|
| `issueCard()` — primary card | `CardLink`, `ApplType=LKTPNECT` (new customer) | SVWG §3.11 |
| `issueVirtualCard()`, type `parent_linked` — add-on card | `CardLink`, `ApplType=LKTPEXSC` (supplementary card for existing account) | SVWG §3.11 |
| `issueVirtualCard()`, type `independent` | `createVirtualCard` | SVWG §3.3 |
| `getBalance()` | `BalanceInquiry` | SVWG §1.8 |
| `setFrozen()` | `ChangeCardStatus` | SVWG §1.5 |
| `setControls()` | `ChangeCardRestrictions` (closest analog — BPC's model is transaction-type/channel based) | SVWG §1.15 |
| `setDailyLimit()` | `ChangeCardLimit` / `ChangeCardLimits` | SVWG §1.7, §1.16 |
| `debit()` / `credit()` | No direct synchronous equivalent — real balance movement happens via ISO 8583 authorization/settlement messages | — |
| Statement (`lib/statement.js`, not part of the provider) | `GetTransactionHistoryBO` (full, filterable) or `getStatement` (last-5 mini-statement) | SVWG §2.2, §1.9 |
| Card list / supplementary card list | `GetCardList`, `GetSuppCards` | SVWG §1.1, §1.6 |

**Confirms our data model is right**: BPC's own `PrimaryIndicator` field
(`GetCardList` response) and `CATEGORY` dictionary (`CRCG0800` = Main,
`CRCG0400` = Additional — SVAP, `CARD` tag) draw the exact same
primary/add-on distinction our `VirtualCard.type` field does.

## What's simulated vs. what's still a gap

- **Simulated now**: every operation above, using BPC's real field names
  and, for the one case that matters (insufficient funds on debit), BPC's
  real error code (`WSA018`, attached as `err.bpcErrorCode` alongside our
  own `err.code = "INSUFFICIENT_FUNDS"` that the rest of the app relies on).
- **Not simulated**: BPC's actual transport (SOAP + WSDL, with a
  `<auth:credentials><user>/<pass></auth:credentials>` SOAP header — SVWG
  §3.11 sample), and the full WSA0xx/WSR0xx error catalog (SVWG §3.2.2/3).
  Both are documented enough here for a real integration to implement
  directly against the mock's method signatures.
- **Architecturally different from BPC**: BPC settles balances
  asynchronously via authorization messages; our simulation debits/credits
  synchronously in the same request. A real integration will likely need a
  webhook/polling reconciliation step here instead.

## Configuration that should live in an Admin Portal (not hardcoded)

Already wired through the DB-backed `SystemSetting` table and the existing
`GET/PATCH /admin/settings/:key` routes — no portal UI yet, but the backend
capability is real:

- `card_bin` — the 6-digit BIN prefix used when generating card numbers.
  Mirrors BPC's real model, where BIN is configured per card "Product"
  (`UNDEFINED_BIN_FOR_PRODUCT` error — SVAP, `PRODUCT_ID`/`PRODUCT_NUMBER`).
- `cms_provider_label` — human-readable label for whichever provider is
  active, for display in an admin screen.
- `household_max_members` — unrelated to the CMS, but the same pattern.

**Deliberately NOT in this table** — these belong in environment variables
(secrets), never in a DB table an admin-portal screen can read out:

- CMS base URL / WSDL endpoint
- CMS API username/password (the SOAP header credentials)
- Any API keys for other providers (Resend, Africa's Talking, etc.)

A future Admin Portal can still *show* whether these are configured
(e.g. "CMS endpoint: configured ✓ / not set") without ever displaying or
accepting the actual secret value through the UI — that's the standard
pattern for keeping secrets out of a database that a support/admin tool can
query.

## To make BIN configurable right now

```bash
curl -X PATCH https://your-api/admin/settings/card_bin \
  -H "Authorization: Bearer <admin access token>" \
  -H "Content-Type: application/json" \
  -d '{"value": "428427"}'
```

(Requires an admin account — see the main README's `npm run make-admin`.)

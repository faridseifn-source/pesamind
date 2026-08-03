const { Router } = require("express");
const prisma = require("../../lib/prisma");
const { requireAuth } = require("../../middleware/auth");
const { requireAdmin } = require("../../middleware/admin");
const { asyncHandler } = require("../../middleware/errorHandler");
const { notFound } = require("../../lib/errors");
const { decryptField } = require("../../lib/crypto");
const { writeAudit } = require("../../lib/audit");
const { publicUser } = require("../../lib/serialize");

const router = Router();
router.use(requireAuth, requireAdmin);

// Requirement 4: this is the backend capability the future Administrator
// Portal will call — no admin UI exists yet, but the access control,
// decryption, and audit trail it depends on are real and enforced today.
// Every view of a customer's full NIDA record is itself audit-logged,
// including which admin looked at which customer's data and when.

router.get(
  "/users/:userId",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("User not found");
    res.json({ user: publicUser(user) });
  })
);

router.get(
  "/users/:userId/kyc",
  asyncHandler(async (req, res) => {
    const profile = await prisma.kycNidaProfile.findUnique({ where: { userId: req.params.userId } });
    if (!profile) throw notFound("No NIDA profile on file for this user");

    const decrypted = {
      firstName: decryptField(profile.firstNameEnc),
      middleName: decryptField(profile.middleNameEnc),
      lastName: decryptField(profile.lastNameEnc),
      sex: decryptField(profile.sexEnc),
      dateOfBirth: decryptField(profile.dateOfBirthEnc),
      maritalStatus: decryptField(profile.maritalStatusEnc),
      placeOfBirth: decryptField(profile.placeOfBirthEnc),
      citizenshipType: decryptField(profile.citizenshipTypeEnc),
      nidaPhone: decryptField(profile.nidaPhoneEnc),
      region: decryptField(profile.regionEnc),
      district: decryptField(profile.districtEnc),
      ward: decryptField(profile.wardEnc),
      villageOrStreet: decryptField(profile.villageOrStreetEnc),
      photoUrl: decryptField(profile.photoEnc),
      sourceProvider: profile.sourceProvider,
      syncStatus: profile.syncStatus,
      syncError: profile.syncError,
      syncedAt: profile.syncedAt,
      lastAttemptAt: profile.lastAttemptAt,
    };

    await writeAudit(req.userId, "admin.kyc.viewed", { ip: req.ip, targetUserId: req.params.userId });
    res.json({ profile: decrypted });
  })
);

module.exports = router;

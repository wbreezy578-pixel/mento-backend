UPDATE "LiveTutorSession"
SET "avatarVoiceProfile" = 'female-avatar-profile'
WHERE "avatarVoiceProfile" IS NULL OR "avatarVoiceProfile" = 'male-avatar-profile';

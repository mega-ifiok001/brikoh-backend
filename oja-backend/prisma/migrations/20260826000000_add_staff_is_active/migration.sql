-- Staff lifecycle (staff upgrades): deactivated members keep their row
-- and history but cannot sign in. Default true keeps existing members
-- active; deactivation revokes refresh tokens at the service layer.

ALTER TABLE "StaffMember" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
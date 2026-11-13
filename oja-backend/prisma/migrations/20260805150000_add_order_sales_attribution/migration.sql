-- Phase 10 analytics: staff sales attribution on orders.

-- Add the nullable attribution column first so the FK can be added against it.
ALTER TABLE "Order" ADD COLUMN "soldByStaffId" UUID;

-- StaffMember.id is UUID; onDelete: SetNull keeps financial history intact
-- when a staff member is deleted (analytics then treats the order as
-- unattributed, matching the service-level behavior).
ALTER TABLE "Order" ADD CONSTRAINT "Order_soldByStaffId_fkey"
  FOREIGN KEY ("soldByStaffId") REFERENCES "StaffMember"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Lookups by staff (per-staff performance) and by store + time + status
-- (analytics range reads). These indexes are the phase's read patterns.
CREATE INDEX "Order_soldByStaffId_idx" ON "Order"("soldByStaffId");
CREATE INDEX "Order_storeId_createdAt_status_idx" ON "Order"("storeId", "createdAt", "status");

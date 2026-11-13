CREATE TABLE "Announcement" (
  "id" UUID NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL, "targetTier" "SubscriptionTier",
  "publishedAt" TIMESTAMPTZ(3), "isActive" BOOLEAN NOT NULL DEFAULT true, "createdByAdminId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Announcement_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Announcement_publishedAt_isActive_targetTier_idx" ON "Announcement"("publishedAt", "isActive", "targetTier");
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");
CREATE TABLE "AnnouncementView" (
  "id" UUID NOT NULL, "announcementId" UUID NOT NULL, "storeId" UUID NOT NULL, "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnouncementView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnnouncementView_announcementId_storeId_key" UNIQUE ("announcementId", "storeId"),
  CONSTRAINT "AnnouncementView_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AnnouncementView_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AnnouncementView_announcementId_idx" ON "AnnouncementView"("announcementId");

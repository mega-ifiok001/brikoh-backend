CREATE TYPE "DeliveryProvider" AS ENUM ('MANUAL', 'SHIPBUBBLE');
CREATE TYPE "ShipbubbleBookingState" AS ENUM ('CREATING', 'BOOKED', 'FAILED', 'UNKNOWN', 'CANCELLED');

ALTER TABLE "DeliveryOption"
  ADD COLUMN "provider" "DeliveryProvider" NOT NULL DEFAULT 'MANUAL';

ALTER TABLE "Product"
  ADD COLUMN "shippingWeightKg" DECIMAL(10,3);

ALTER TABLE "Order"
  ADD COLUMN "shipbubbleCourierId" VARCHAR(100),
  ADD COLUMN "shipbubbleServiceCode" VARCHAR(100),
  ADD COLUMN "shipbubbleRateQuoteId" UUID;

CREATE UNIQUE INDEX "Order_shipbubbleRateQuoteId_key" ON "Order"("shipbubbleRateQuoteId");

CREATE TABLE "ShipbubbleStoreConfig" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "senderAddressCode" INTEGER NOT NULL,
  "categoryId" INTEGER NOT NULL,
  "packageLengthCm" DECIMAL(8,2) NOT NULL,
  "packageWidthCm" DECIMAL(8,2) NOT NULL,
  "packageHeightCm" DECIMAL(8,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ShipbubbleStoreConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShipbubbleStoreConfig_storeId_key" ON "ShipbubbleStoreConfig"("storeId");
ALTER TABLE "ShipbubbleStoreConfig" ADD CONSTRAINT "ShipbubbleStoreConfig_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ShipbubbleAddressCache" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "addressCode" INTEGER NOT NULL,
  "formattedAddress" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipbubbleAddressCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShipbubbleAddressCache_storeId_fingerprint_key"
  ON "ShipbubbleAddressCache"("storeId", "fingerprint");
ALTER TABLE "ShipbubbleAddressCache" ADD CONSTRAINT "ShipbubbleAddressCache_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ShipbubbleRateQuote" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "requestToken" VARCHAR(200) NOT NULL,
  "deliveryOptionId" UUID NOT NULL,
  "cartFingerprint" VARCHAR(64) NOT NULL,
  "destinationFingerprint" VARCHAR(64) NOT NULL,
  "courierRates" JSONB NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShipbubbleRateQuote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShipbubbleRateQuote_storeId_expiresAt_idx"
  ON "ShipbubbleRateQuote"("storeId", "expiresAt");
ALTER TABLE "ShipbubbleRateQuote" ADD CONSTRAINT "ShipbubbleRateQuote_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipbubbleRateQuote" ADD CONSTRAINT "ShipbubbleRateQuote_deliveryOptionId_fkey"
  FOREIGN KEY ("deliveryOptionId") REFERENCES "DeliveryOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_shipbubbleRateQuoteId_fkey"
  FOREIGN KEY ("shipbubbleRateQuoteId") REFERENCES "ShipbubbleRateQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ShipbubbleShipment" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "providerOrderId" VARCHAR(200),
  "requestToken" VARCHAR(200) NOT NULL,
  "courierId" VARCHAR(100) NOT NULL,
  "serviceCode" VARCHAR(100) NOT NULL,
  "courierName" VARCHAR(200) NOT NULL,
  "customerFee" DECIMAL(10,2) NOT NULL,
  "providerFee" DECIMAL(10,2),
  "currency" VARCHAR(8) NOT NULL DEFAULT 'NGN',
  "bookingState" "ShipbubbleBookingState" NOT NULL DEFAULT 'CREATING',
  "providerStatus" VARCHAR(80),
  "trackingUrl" VARCHAR(2048),
  "waybillUrl" VARCHAR(2048),
  "providerResponse" JSONB,
  "lastWebhookFingerprint" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ShipbubbleShipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShipbubbleShipment_orderId_key" ON "ShipbubbleShipment"("orderId");
CREATE UNIQUE INDEX "ShipbubbleShipment_providerOrderId_key" ON "ShipbubbleShipment"("providerOrderId");
CREATE INDEX "ShipbubbleShipment_storeId_createdAt_idx" ON "ShipbubbleShipment"("storeId", "createdAt");
ALTER TABLE "ShipbubbleShipment" ADD CONSTRAINT "ShipbubbleShipment_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipbubbleShipment" ADD CONSTRAINT "ShipbubbleShipment_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

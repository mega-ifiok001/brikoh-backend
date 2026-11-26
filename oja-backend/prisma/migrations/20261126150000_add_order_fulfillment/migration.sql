CREATE TYPE "FulfillmentStatus" AS ENUM (
  'ORDER_RECEIVED',
  'CONFIRMED',
  'PREPARING',
  'READY_FOR_DISPATCH',
  'DISPATCHED',
  'DELIVERED',
  'DELIVERY_FAILED',
  'READY_FOR_PICKUP',
  'COLLECTED',
  'CANCELLED'
);

CREATE TYPE "FulfillmentEventSource" AS ENUM ('MERCHANT', 'SHIPBUBBLE', 'SYSTEM');

ALTER TABLE "Order"
  ADD COLUMN "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'ORDER_RECEIVED',
  ADD COLUMN "deliveryProvider" VARCHAR(40),
  ADD COLUMN "courierName" VARCHAR(200),
  ADD COLUMN "courierPhone" VARCHAR(30),
  ADD COLUMN "shipmentReference" VARCHAR(200),
  ADD COLUMN "trackingUrl" VARCHAR(2048);

CREATE TABLE "OrderFulfillmentEvent" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "status" "FulfillmentStatus" NOT NULL,
  "source" "FulfillmentEventSource" NOT NULL DEFAULT 'MERCHANT',
  "note" VARCHAR(500),
  "actorStaffId" UUID,
  "courierName" VARCHAR(200),
  "shipmentReference" VARCHAR(200),
  "idempotencyKey" VARCHAR(200),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderFulfillmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderFulfillmentEvent_idempotencyKey_key"
  ON "OrderFulfillmentEvent"("idempotencyKey");
CREATE INDEX "OrderFulfillmentEvent_orderId_createdAt_idx"
  ON "OrderFulfillmentEvent"("orderId", "createdAt");
ALTER TABLE "OrderFulfillmentEvent"
  ADD CONSTRAINT "OrderFulfillmentEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "OrderFulfillmentEvent" ("id", "orderId", "status", "source", "createdAt")
SELECT gen_random_uuid(), "id", 'ORDER_RECEIVED', 'SYSTEM', "createdAt" FROM "Order";

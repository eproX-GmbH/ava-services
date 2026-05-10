-- v0.1.103 — track Stripe cancel-at-period-end so the desktop can show
-- "Kündigung zum 31.05.2026 vorgemerkt" while the subscription is
-- winding down. Default false; webhook flips to true on
-- customer.subscription.updated when the user cancels via the
-- Customer Portal, and back to false if they un-cancel.

ALTER TABLE "TenantBilling"
  ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT FALSE;

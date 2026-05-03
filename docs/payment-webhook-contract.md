# Payment Webhook Contract — AI Reliability

## Purpose

The selected payment provider collects payment and sends payment- and subscription-related events to your integration. AI Reliability owns entitlement mapping, credits, configured budget limits, and access delivery. Webhooks bridge provider events to that internal model: each verified event should drive create/update of customer entitlements and operational follow-up (email, logging) according to the rules below.

## Required Event Types

Integrations should be prepared to handle at least:

- **purchase completed**
- **subscription activated**
- **subscription renewed**
- **subscription canceled**
- **refund**
- **chargeback**

Exact naming may differ per provider; map incoming event types to these logical categories in your adapter layer.

## Required Payload Fields

Each handled event should carry or allow derivation of:

| Field | Notes |
| ----- | ----- |
| Customer email | Primary identity for access and communication |
| Product ID | Stable catalog identifier from the provider |
| Product name | Human-readable label |
| Plan ID or plan name | Must map to Starter, Team, or Growth (or your canonical plan keys) |
| Order ID | One-time purchase reference when applicable |
| Subscription ID | Recurring agreement reference when applicable |
| Payment status | Succeeded, failed, pending, etc., per provider semantics |
| Event timestamp | When the provider recorded the event |
| Signature / verification field | If the payment provider supplies a signed payload or shared secret for verification, validate before trusting fields |

## Internal Entitlement Mapping

Canonical mapping for configured evaluation entitlements (credits and spend-gate budget ceilings):

| Plan | Credits | Configured budget (USD) |
| ---- | ------- | ------------------------ |
| starter | 1,000 | 500 |
| team | 5,000 | 2,500 |
| growth | 15,000 | 10,000 |

Normalize plan identifiers from the webhook (IDs or display names) to these keys before applying credits and budget state.

## Fulfillment Behavior

**On successful payment** (purchase completed, subscription activated, or renewal that extends paid access):

- Create or update the customer entitlement record.
- Mark entitlement status **active**.
- Send the access email (per your access-delivery process).
- Record order ID, subscription ID (if any), and which payment system produced the event.

**On cancellation, refund, or chargeback:**

- Mark entitlement status **canceled** or **review-required** (per your policy).
- Stop future access where appropriate (e.g. revoke or flag account; do not grant new eval capacity until reviewed).

## Warning

**Do not implement final webhook parsing until the selected payment provider supplies official payload examples and signing rules.** Prototype against documented samples and verified signatures before production use.

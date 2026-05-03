# AI Reliability — Access delivery (manual)

## Manual Access Delivery Process

After a customer completes checkout:

1. **Verify payment or order** in the active payment provider’s dashboard (status succeeded / completed per that system’s definitions).
2. **Identify the purchased plan** (Starter, Team, or Growth) from the order or receipt.
3. **Confirm the customer email** on the order; use it as the delivery address unless a separate contact is specified.
4. **Send the access email** using the template below, personalizing name, plan, credits, and links as needed.
5. **Log** customer email, plan, order ID, which payment system was used, and date (spreadsheet, CRM, or internal ticket—whatever your team uses).
6. **Provide contacts** in every access email: Support: support@aireliabilityhq.com · Billing: billing@aireliabilityhq.com.

## Access Email Template

**Subject:** Your AI Reliability access

**Body:**

```
Hi <Name>,

Your AI Reliability <Plan> access has been confirmed.

You can start here:
- Quickstart: <link to quickstart>
- Failure reports: https://aireliabilityhq.com/reports/
- Support: support@aireliabilityhq.com
- Billing: billing@aireliabilityhq.com

Your plan includes:
- <credits> evaluation credits
- configured evaluation spend-gate checks
- plan-specific datasets and workflows

Recommended first commands:
npm install
npm run demo:failures
npm run demo:budget-gate

Thanks,
AI Reliability
```

Replace `<Name>`, `<Plan>`, `<credits>`, and `<link to quickstart>` with customer-specific values before sending.

## Plan Mapping

| Plan    | Credits |
| ------- | ------- |
| Starter | 1,000   |
| Team    | 5,000   |
| Growth  | 15,000  |

## Provider-Agnostic Notes

- The payment provider collects payment and confirms the transaction in its own dashboard and tooling.
- AI Reliability owns entitlement mapping, access delivery, credits, and configured spend-gate state in the product and documentation.
- Final automation should only be implemented after the selected provider confirms webhook payloads and signing rules.

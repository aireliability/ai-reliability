# Hallucinated API field names

## Failure Scenario

The model documents a `POST /v2/invoices/{id}/void` endpoint with a `reason` body field. That route does not exist in your API. Integrations copy the snippet and production calls fail with 404.

## Example Input

> "How do I void an invoice via the API? Give me curl."

## Expected Behavior

Only describe endpoints and parameters that exist in your published OpenAPI/spec (or say you cannot confirm and point to docs). If voiding is unsupported, say so clearly.

## Why This Matters

Hallucinated APIs waste engineering time, break client code, and erode trust in all AI-generated docs. One bad snippet in prod can block releases or cause outages for partners.

## How to Test This

An eval run would **FAIL** when the answer cites paths, methods, or fields that are not in your published OpenAPI/spec. An **API surface** or **schema allowlist** rule rejects any invented routes or parameters.

# 有单·旅游管理系统产品定位

## Users and value

The documented product serves travel-agency staff handling customer leads, inquiries, quotations, orders, travelers, suppliers, receipts/payments, approvals, resources, and reporting. Roles include administrators and finance staff; exact permissions and data scope must follow verified product requirements.

Core value: keep the customer-to-trip workflow, supplier/resource execution, and financial approval traceable in one system.

## Decision principles

- Protect tenant boundaries and financial integrity before convenience.
- Preserve an audit trail for approvals, settlement, and destructive actions.
- Make status and outstanding work visible; do not silently infer missing user input.
- AI-assisted extraction should not silently create persistent master data; observed target behavior has a write side effect, so treat the safer two-step approach as a replication design recommendation, not an existing target fact.
- Clearly label unverified behavior and defer product decisions listed as C-level gaps to the business owner.

## TODO

Confirm primary user personas, supported agency sizes, localization requirements, and product success metrics with the product owner.

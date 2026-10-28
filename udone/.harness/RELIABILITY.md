# Reliability rules

- Fail clearly when required dependencies are unavailable; expose health checks without leaking credentials or internals.
- Use bounded timeouts and retries only for transient, idempotent operations. Never blindly retry financial writes or other non-idempotent commands.
- Use idempotency controls where supported by the actual API contract; do not assume an endpoint is idempotent without evidence.
- Keep transaction boundaries around related financial/state updates and record audit events for sensitive transitions.
- Logs should include useful correlation/context while excluding passwords, tokens, cookies, payment credentials, and unnecessary personal data.
- Operational release gates include service integration, 50-concurrent resource contention, and a restore rehearsal with measured RPO/RTO. These remain environment-dependent until evidenced.
- Current implementation has request IDs and a centralized safe HTTP error boundary, but no separate logging framework, retry middleware, queue, or alerting service was found. Do not assume retry/delivery/alert guarantees; specify and test them in the task that introduces an asynchronous or externally retried operation.

Configuration, deployment and merge checks follow [engineering standards](ENGINEERING_STANDARDS.md); runtime behavior and release claims are evidenced under [testing standards](TESTING_STANDARDS.md).

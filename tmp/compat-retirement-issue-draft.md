Legacy compatibility endpoint retirement body moved into issue #171.

Scope:
- remove GET /api/auth/status
- remove POST /api/auth/redeem
- remove POST /api/catalog/sync
- remove scripts that invoke deprecated endpoints
- update tests/docs

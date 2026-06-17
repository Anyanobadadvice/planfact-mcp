export const PLANFACT_BASE_URL =
  process.env.PLANFACT_BASE_URL?.replace(/\/$/, "") || "https://api.planfact.io";

export const PLANFACT_DEFAULT_LIMIT = Number.parseInt(
  process.env.PLANFACT_DEFAULT_LIMIT || "50",
  10,
);

export const REQUIRE_CONFIRMATION_FOR_WRITES =
  (process.env.PLANFACT_REQUIRE_CONFIRMATION_FOR_WRITES || "true").toLowerCase() !==
  "false";

export const PLANFACT_API_PREFIX = "/api/v1";

export const PLANFACT_INCOME_OPERATION_PATH =
  process.env.PLANFACT_INCOME_OPERATION_PATH || "/operations/income";

export const PLANFACT_OUTCOME_OPERATION_PATH =
  process.env.PLANFACT_OUTCOME_OPERATION_PATH || "/operations/outcome";

export const PLANFACT_MOVE_OPERATION_PATH =
  process.env.PLANFACT_MOVE_OPERATION_PATH || "/operations/move";

export const PLANFACT_COUNTERPARTY_PATH =
  process.env.PLANFACT_COUNTERPARTY_PATH || "/contragents";

export const PLANFACT_OPU_ACCRUAL_PATH =
  process.env.PLANFACT_OPU_ACCRUAL_PATH || "/operations/accrual";

export const PLANFACT_DEFAULT_COMPANY_ID = process.env.PLANFACT_COMPANY_ID
  ? Number.parseInt(process.env.PLANFACT_COMPANY_ID, 10)
  : undefined;

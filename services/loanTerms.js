import env from "../env.js";

// The loan terms a borrower agrees to when applying. Bump the version (and
// the UI's terms document) whenever what a borrower agrees to changes,
// including any of the env.loans numbers below: applications must name the
// current version, and each one records the version it was made under.
export const LOAN_TERMS_VERSION = "loan-terms-v1";
export const LOAN_TERMS_EFFECTIVE = "2026-10-07";

/** GET /v1/loans/terms: the current terms and the numbers they quote. */
export function currentLoanTerms() {
  return {
    version: LOAN_TERMS_VERSION,
    effective_date: LOAN_TERMS_EFFECTIVE,
    grace_days: env.loans.graceDays,
    late_fee_bps: env.loans.lateFeeBps,
    late_fee_min_minor: env.loans.lateFeeMinMinor,
    default_after_days: env.loans.defaultAfterDays,
    min_repayment_minor: env.loans.minRepaymentMinor,
  };
}

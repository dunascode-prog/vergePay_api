// Amortization for fixed-rate loans repaid in equal monthly installments
// (data model 4.10). Everything is integer minor units.
//
// Rounding a level payment and carrying the error forward drifts badly on
// long terms (a 30-year loan can be "paid off" years early). Instead each
// row's principal is the step in the exact schedule's cumulative principal,
// rounded: round(C_k) - round(C_k-1). The principal portions then add up to
// exactly the principal, and interest is charged on the rounded balance, so
// every installment is within a minor unit or two of the level payment.

function monthlyRate(interestRateBps) {
  return interestRateBps / 10_000 / 12;
}

// The level monthly payment: P * r / (1 - (1 + r)^-n), or P / n at 0%.
export function monthlyInstallment({ principalMinor, interestRateBps, termMonths }) {
  const r = monthlyRate(interestRateBps);
  if (r === 0) return Math.round(principalMinor / termMonths);
  return Math.round((principalMinor * r) / (1 - (1 + r) ** -termMonths));
}

// "2026-01-31" + 1 month -> "2026-02-28": a due date that doesn't exist in
// the target month moves to that month's last day.
export function addMonths(isoDate, months) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(day, lastDay));
  return first.toISOString().slice(0, 10);
}

// Principal repaid after k installments in the exact (unrounded) schedule.
function cumulativePrincipal(principalMinor, r, termMonths, k) {
  if (k === termMonths) return principalMinor;
  if (r === 0) return (principalMinor * k) / termMonths;
  const growth = (1 + r) ** termMonths;
  return (principalMinor * ((1 + r) ** k - 1)) / (growth - 1);
}

// One row per month, the first due one month after startDate (YYYY-MM-DD).
export function buildSchedule({ principalMinor, interestRateBps, termMonths, startDate }) {
  const r = monthlyRate(interestRateBps);

  const rows = [];
  let repaid = 0;
  for (let n = 1; n <= termMonths; n++) {
    const repaidAfter = Math.round(cumulativePrincipal(principalMinor, r, termMonths, n));
    const principal = repaidAfter - repaid;
    const interest = Math.round((principalMinor - repaid) * r);
    rows.push({
      installment_number: n,
      due_date: addMonths(startDate, n),
      principal_minor: principal,
      interest_minor: interest,
      installment_amount_minor: principal + interest,
    });
    repaid = repaidAfter;
  }
  return rows;
}

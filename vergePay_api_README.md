# VergePay API

The backend engine powering **VergePay** — a full-stack fintech platform built for Nigerian freelancers and SMEs to manage income, expenses, and business finance in one place.

> ⚠️ **Status:** Actively in development. Core modules (Wallets, Ledger, Client/Invoice management) are functional; other features are being built out incrementally. Not production-ready yet.

---

## Overview

Freelancers and small businesses in Nigeria juggle personal and business money across multiple apps, banks, and spreadsheets — with no clear picture of cash flow, client reliability, or business health. VergePay API provides the backend infrastructure to unify that: personal and business wallets, a double-entry ledger, invoicing and recurring billing, client payment-reliability scoring, and AI-assisted financial insight — all behind one API.

This repository is the backend service. The frontend dashboard lives in [`vergePay_ui`](https://github.com/dunascode-prog/vergePay_ui).

---

## Core Modules

- **Wallets** — Personal Wallet and Business Wallet, each with independent balances, transaction history, and actions (add funds, send, transfer between wallets).
- **Ledger** — Double-entry bookkeeping under the hood so every transaction is auditable and balances always reconcile.
- **Invoicing & Recurring Billing** — Create and send invoices, track expenses, and automate recurring charges (subscriptions, retainers, auto-debits).
- **Client Health** — Payment-reliability scoring for recurring clients, based on on-time payment history, to flag accounts that need attention.
- **Performance Overview / Analytics** — Income, spend, net cash flow, and investment-rate metrics for personal, business, or combined views.
- **AI Integration (LangChain)** — AI-assisted insights layered on top of transaction and client data.
- **Payments & Payouts** — Integrations with **Flutterwave** (payments/collections) and **Mono** (account linking/data).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express |
| ORM / Database | Prisma |
| AI | LangChain |
| Payments | Flutterwave |
| Open Banking / Account Linking | Mono |
| Logging | Custom logger (`logger.js`) |

---

## Project Structure

```
vergePay_api/
├── controllers/     # Request handlers / business logic
├── db/              # Prisma schema & database config
├── documentation/   # API/architecture docs
├── routes/          # Express route definitions
├── utils/           # Shared helpers
├── app.js           # Express app setup
├── env.js           # Environment config loader
├── logger.js         # Logging utility
└── server.js         # Entry point
```

---

## Getting Started

### Prerequisites
- Node.js (LTS recommended)
- A PostgreSQL (or Prisma-supported) database
- Flutterwave and Mono API credentials (for payment/account-linking features)

### Installation

```bash
git clone https://github.com/dunascode-prog/vergePay_api.git
cd vergePay_api
npm install
```

### Environment Variables

Create a `.env` file in the root directory. At minimum you'll need:

```env
DATABASE_URL=
PORT=
FLUTTERWAVE_SECRET_KEY=
MONO_SECRET_KEY=
JWT_SECRET=
```

*(See `env.js` for the full list of variables the app expects.)*

### Database Setup

```bash
npx prisma generate
npx prisma migrate dev
```

### Run the Server

```bash
npm run dev
# or
node server.js
```

---

## Roadmap

- [x] Wallet system (Personal / Business)
- [x] Double-entry ledger
- [x] Client health scoring
- [ ] Wealth Tracker module
- [ ] Full AML/fraud-awareness checks
- [ ] Production-grade auth & role-based access
- [ ] Public API documentation
- [ ] Deployment pipeline

---

## Related Repositories

- Frontend: [vergePay_ui](https://github.com/dunascode-prog/vergePay_ui)

---

## Author

Built by **Seyi** ([dunascode-prog](https://github.com/dunascode-prog)) — Software Engineering student & backend/fintech developer.

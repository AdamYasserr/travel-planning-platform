# Travel Planning & Booking Platform — Backend

## 1. Project Overview

The backend of the Travel Planning & Booking Platform, developed as part of Software Project I at the German International University.

The backend provides REST APIs for authentication, account management, travel planning, bookings, payments, and community features.

## 2. Technology Stack

- **Framework:** NestJS
- **Language:** TypeScript
- **Database:** MongoDB Atlas
- **ODM:** Mongoose (confirm against the installed dependencies)
- **API Documentation:** Swagger
- **Authentication:** JWT with HttpOnly cookies

## 3. Project Structure

```text
backend/
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   └── media/
│   ├── common/
│   ├── config/
│   └── main.ts
├── docs/
├── test/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

*Update this structure to match the actual repository.*

## 4. Prerequisites

- Node.js
- npm
- MongoDB Atlas account
- Git

## 5. Installation

Clone the repository:

```bash
git clone <repository-url>
cd travel-planning-platform/backend
```

Install dependencies:

```bash
npm install
```

## 6. Environment Configuration

Create a `.env` file in the backend directory using `.env.example` as a reference.

Configure the required environment variables, including:

- MongoDB connection string
- JWT configuration
- Cookie configuration
- Other required external service credentials

Never commit `.env` or expose credentials in the repository.

## 7. Running the Backend

Development:

```bash
npm run start:dev
```

Production build:

```bash
npm run build
```

Production:

```bash
npm run start:prod
```

## 8. Testing

Run unit tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:cov
```

Run lint:

```bash
npm run lint
```

## 9. API Documentation

Swagger UI:

```text
http://localhost:3000/docs
```

The global API prefix and port depend on the backend configuration.

## 10. Development Guidelines

- Follow the existing NestJS module structure.
- Keep controllers responsible for handling HTTP requests.
- Implement business logic inside services.
- Validate incoming requests on the backend.
- Enforce authentication, authorization, and ownership restrictions.
- Reference official requirement IDs in related commits and pull requests.
- Do not commit environment files, secrets, or generated build files.

## 11. Git Workflow

Use feature branches created from `develop`.

Example:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/ACC-01-registration
```

Submit completed work through pull requests targeting `develop`.

# ACE HRMS – ACE Web Experts

## Local development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

The Express server provides the Vite development middleware and the `/api/*` endpoints.

## Production build

```bash
npm run lint
npm run build
npm start
```

## Firebase configuration and safety

- The existing `firebase-applet-config.json`, Firebase client setup, and project configuration are retained from the supplied ZIP.
- Server-side attendance, break control, reminders and scheduled announcement jobs use the Firebase Admin SDK. Configure Application Default Credentials in Google-hosted environments or provide a service account securely through `GOOGLE_APPLICATION_CREDENTIALS` on other hosts.
- Never put a service-account private key in the ZIP, Git, or client-side environment variables.
- Review `firestore.rules` and `storage.rules` against the live project and test them with Firebase Emulator before publishing. Admin SDK server writes bypass Firestore client rules.
- Configure SMTP variables in the hosting environment for outbound email. In-app notifications do not require SMTP.

## Desktop monitoring agent

The Electron desktop agent is in `desktop-agent/`.

```bash
cd desktop-agent
npm install
npm start
```

To package an installer for the current platform:

```bash
npm run dist
```

The employee signs in with their verified ACE HRMS account and explicitly accepts the disclosure. The agent also provides a Stop control and a Withdraw Consent & Sign Out control. The agent needs OS screen-capture permission and an internet connection. Firebase Admin credentials and the configured Storage bucket are required by the server. Review `MONITORING-POLICY.md` with HR/legal before enabling it for employees.

## Security rules static test

```bash
node --experimental-strip-types firestore.rules.test.ts
```

## Requirements status

See `REQUIREMENTS-IMPLEMENTATION-STATUS.md` for a point-by-point record of implemented, partial and pending items. This archive is not represented as a fully complete production release: MFA/2FA, backup automation and several Phase 2/3 workflows still require implementation and integration. The desktop agent source is included but must be built and end-to-end tested on each target OS before rollout.

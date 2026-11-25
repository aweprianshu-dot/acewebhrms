# ACE Web Experts – Employee Desktop Monitoring Notice

**Policy version:** 2026-11-21  
**Applies to:** Employees using the ACE HRMS desktop monitoring agent.

## What the agent records
- Random desktop screenshots at intervals of approximately 5–10 minutes.
- Active application name and active window title when available.
- Operating-system idle time and a coarse activity indicator.

The agent does not continuously record video or audio.

## When monitoring runs
- Monitoring is allowed only when the employee has checked in and has not checked out.
- Monitoring pauses during a recorded break.
- A logged meeting remains paid working time; monitoring can remain active.
- The desktop agent displays its current state, including “Monitoring ON” while active.

## Access and retention
- Screenshots are available only to authorized Team Leads, Managers, HR and Super Admin users within their permitted department scope.
- Screenshot views are written to the HRMS audit log.
- The default retention is 60 days. The server setting `MONITORING_RETENTION_DAYS` can be set from 30 to 90 days; expired screenshot files and metadata are deleted by the server cleanup job.

## Employee consent and deployment
The agent requires the employee to sign in with a verified work account and explicitly accept the disclosure before monitoring can start. Consent is stored against the employee account and policy version. Employees can stop the agent and withdraw consent from the agent window; withdrawal immediately disables further captures.

This technical notice is not a substitute for legal review. ACE Web Experts should have the final policy, consent language, notice period, employee rights, cross-border processing and data access procedures reviewed for applicable privacy and employment laws (including India's DPDP Act where applicable) before enabling the agent for employees.

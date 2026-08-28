# MeridianIQ moderated usability protocol

## Purpose

Validate the workflows that code review and automated checks cannot prove:
whether a first-time user understands the product's language, notices the
right action, predicts the consequence, and recovers without facilitator help.
This is a test plan, not a record of completed sessions.

## Participants

Recruit 8 to 10 people who have not worked on MeridianIQ:

- 3 Nigerian SME owners or finance leads who issue invoices.
- 3 accountants or tax practitioners who manage several client businesses.
- 2 internal operations or assurance users.
- Add 1 to 2 keyboard-only or screen-reader users across those roles where
  recruitment permits.

Do not use production accounts or production client data. Give each participant
a seeded test identity and synthetic company. Obtain consent before recording;
store recordings separately from product telemetry and delete them on the
agreed schedule.

## Sessions

Run 45-minute, one-to-one sessions. Ask participants to think aloud, but do not
name the target control or teach the workflow. Stop a task after three minutes
without progress and record the point of failure.

1. From the public landing page, find sign-in and identify which workspace the
   supplied invitation will activate.
2. As an accountant, add a client and create access for the client owner.
3. Return to a filtered client book, save the view, open a client, pin it, and
   find it again without using browser history.
4. As an SME, import a sheet containing valid, invalid, and duplicate rows;
   explain what was and was not saved.
5. Submit an invoice for stamping, explain the VAT and correction consequence,
   then recover from a simulated connection interruption without duplicating
   the action.
6. Start and re-check onboarding, leave the page, and find its latest status.
7. Send a multi-invoice bundle to Clerk, navigate away, return, and explain its
   state and what still needs human review.
8. Find help for an unfamiliar term, report whether the answer helped, and
   locate the human-support route when search has no result.

## Measures

For every task record completion (success, assisted, failed), time on task,
wrong turns, backtracks, facilitator prompts, error recoveries, and the user's
confidence on a 1-to-5 scale. Note the first click and the participant's words
for any misunderstood label. For accessibility sessions, also record focus
order, announced state changes, and any control without a usable name.

Release targets for the first round:

- At least 80% unassisted completion for invitation, import, and stamping.
- No participant performs a duplicate import or submission during recovery.
- Median confidence at least 4/5 after the consequence review.
- Every participant can locate Activity and Help without facilitator direction.
- No critical keyboard or screen-reader blocker.

## Reporting

Create one finding per observed failure with role, task, evidence, severity,
frequency, and the smallest plausible remediation. Never place participant
names, company names, invoice content, search text, or recordings in the
repository. Re-test high-severity fixes with at least two affected-role users
before release.

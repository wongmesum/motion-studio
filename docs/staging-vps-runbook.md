# Motion Studio staging rollout — manual approval gate

The source branch `feature/ai-motion-editor` is a **Draft PR**. Do not deploy
to the production domain or merge it simply because a CI job passed.
The ChatGPT GitHub integration does **not** provide host SSH access.

## 1. Verify host readiness without changing any services

Connect to Amazon Linux 2023 using the operator's existing SSH method.
Run the read-only readiness script from a trusted checkout:

```bash
bash scripts/check-vps-staging.sh
```

Check free disk, RAM, Node.js 20+, FFmpeg/FFprobe, Docker and Nginx capacity.
Playwright also requires a compatible Chromium and system libraries.
**Do not upload SSH private keys or server passwords to ChatGPT.**

## 2. Prepare an isolated staging area

- Use a dedicated unprivileged Linux account and an isolated checkout of
  `feature/ai-motion-editor` (pin a verified commit SHA).
- Use separate Redis/job names and output folders where relevant; never reuse
  production queue credentials and storage paths.
- Only install project dependencies after verifying disk capacity. Do not
  perform any deployment on the current 8 GB root disk without checking
  available space and planning cleanup/volume expansion.
- Validate `npm ci` and `npm test` in staging, then run
  `node scripts/smoke-motion-mp4.js`. The smoke script generates
  **8 landscape frames** (1920×1080) and **4 portrait frames** (1080×1920)
  and removes temporary output after checking it with FFprobe.
- Confirm real videos do not truncate overlays, hide captions, overflow safe
  regions, or accidentally include editor-only keyframe handles.
- Use an authenticated staging reverse proxy and explicit human approval
  before changing Nginx routes, systemd, Docker or production services.

## 3. Release and rollback policy

1. Archive the current production deployment commit, environment configuration
   and compatible persistent state.
2. Deploy to staging first, and review samples in landscape and portrait.
3. Obtain explicit approval for production; do not auto-merge the PR.
4. Use a versioned deployment with an immediate rollback target. Monitor
   Nginx error logs, worker health, queues, temporary frame disk usage and
   FFmpeg failures.
5. If smoke tests fail, leave production unchanged and record the failure
   in the draft PR.

## Known scope limitations

The portrait adapter *contains* each 1920×1080 template inside the 9:16
output canvas (gradient outside), rather than generating native vertical
layouts. Lottie playback deliberately supports a vetted subset of vector ray
animations, not arbitrary Lottie JSON/expression execution. Adding new
template-specific portrait layouts and additional approved Lottie assets is
separate from the safe staging proof.

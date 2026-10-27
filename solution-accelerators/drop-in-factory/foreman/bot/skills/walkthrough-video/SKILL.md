---
name: walkthrough-video
description: Record a short screen walkthrough of a change and embed it in the run's pull request description. Used by the verify step.
---

# Walkthrough video

Start a screen recording, show the change working (run the app and use the feature, or run the tests on screen when there is nothing to click), then save the recording under `/opt/cursor/artifacts/`. Embed it in the pull request description the way you embed any walkthrough artifact: update the pull request with your pull-request tool, keep the existing description, and add a `## Walkthrough` section with `<video src="/opt/cursor/artifacts/<name>.mp4"></video>`. The tool uploads the file and rewrites the `src` to a public URL. Read the description back and copy that URL into `video`.

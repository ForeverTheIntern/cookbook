# Slack requests find their repository

In a Slack channel several repositories share, a request doesn't have to name its repository. Foreman tries a leading key or `in <key>` first, then matches the request's content words against each repository's key, name and `description`, and only then hands the list to its model, which opens the issue with `open_request` or asks the person when the request could fairly be either.

The request text is cleaned of mentions, Slack escapes and code or quote formatting before any matching, so a key pasted with formatting still matches, and the hint Foreman replies with is built from the cleaned text.

Keywords come before the model so the common case is instant and testable on real event text. The model is the fallback, not the router, and it may only open an issue in a repository of that channel.

Foreman replies "Working on it." before any of this, and a request whose content words mostly match an open run's title links that run and its thread instead of opening a second issue.

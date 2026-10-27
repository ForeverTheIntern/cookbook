# One TypeScript package

The factory is one Node package at the factory root, with `engines.node` set to `>=22.14.0` (`.nvmrc` holds the tested minimum). Foreman's BDK project imports the same `foreman/bot/lib/` modules; there is no second copy of any code. Node runs the TypeScript directly with type stripping.

`foreman/bot/lib/config/env.ts` is the only reader of `process.env`. Each setting has one name, and a missing name fails with that name. `factory.yaml` has no defaults and no aliases: an unknown or missing key stops Foreman.

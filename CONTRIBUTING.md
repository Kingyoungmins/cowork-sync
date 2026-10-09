# Contributing to cowork-sync

Thank you for helping. cowork-sync is a personal source-available project. It is not
affiliated with, sponsored by or endorsed by any company or employer.

## Licence and CLA

cowork-sync is released under the Functional Source License 1.1 with the
Apache License 2.0 as its future licence (see [LICENSE.md](LICENSE.md)): each
version becomes available under Apache-2.0 two years after it is released.

Every contribution needs the contributor licence agreement in [CLA.md](CLA.md).
It lets the licensor publish your work under the project licence and, later,
under other terms, including commercial ones. To agree, comment on your pull
request with this exact sentence:

> I have read the CLA and agree to it

A pull request without that comment from each of its authors cannot be merged.
Signatures are recorded publicly in this repository, in
`.github/cla/signatures.json` (your username on the code host, the date and a
link to your agreement comment).

## Questions and security reports

General questions, including about licensing: minzbusiness0204@gmail.com.

Please do not report a security problem in a public issue or by e-mail. Use the
repository's private vulnerability reporting instead (the "Security" tab, then
"Report a vulnerability"); [SECURITY.md](SECURITY.md) has the details once the
project is public.

## Test first (TDD)

Every change to behaviour starts with a test that fails:

1. Write the test in `test/unit` or `test/integration` and run it. It must fail
   for the reason you expect.
2. Write the smallest code in `src` that makes it pass.
3. Refactor with the tests green.

A bug fix starts with a test that reproduces the bug. A pull request that
changes behaviour without a test that would have caught the change will be
asked for one.

## `npm run ci` must be green

Use Node.js 20.6 or newer. Before you open or update a pull request, run:

```sh
npm ci
npm run ci
```

`npm run ci` runs the same five gates as the hosted CI, in this order: `lint`,
`typecheck`, `build`, `test` and `sim:smoke`. All five must pass on your
machine, and the hosted CI must be green on Windows, macOS and Linux before a
pull request is merged.

## Release note for maintainers

`package.json` keeps `"private": true`: the plugin is distributed through the
Claude Code plugin marketplace, not npm, and the npm name placeholder is a
separate package under `release/`. Do not change it in a pull request.

`LICENSE.md` is the official FSL-1.1-ALv2 template from https://fsl.software,
copied unchanged except for the year and the licensor name in its Notice line
(Youngmin Seo, confirmed by the owner on 2026-10-08). `CLA.md` refers to the
licensor named in that Notice, so a change of name touches only `LICENSE.md`.

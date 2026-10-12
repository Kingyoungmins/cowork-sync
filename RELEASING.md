# Releasing cowork-sync

This file is for the maintainer. It lists the exact steps that publish a release as a Claude Code plugin.

## How the plugin is laid out

- `plugin/` is the plugin root. On `main` it holds only the hand-written files:
  - `plugin/.claude-plugin/plugin.json`: the manifest (name, version, author, licence, links).
  - `plugin/commands/cowork.md`: the `/cowork-sync:cowork` slash command. It runs
    `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" $ARGUMENTS` before the prompt reaches Claude, and it pre-approves only that call.
  - `plugin/package.json`: `{"type": "module"}`, so node reads the bundles as ES modules. It declares no dependency, and
    `plugin/` must never hold a lockfile. Claude Code installs a plugin's dependencies only when both a `package.json` and a
    lockfile are present, so it never runs an install for this plugin.
- `.claude-plugin/marketplace.json` at the repository root is the catalog. Its one entry installs the `plugin/` folder of the
  release tag:
  `{"source": "git-subdir", "url": "https://github.com/Kingyoungmins/cowork-sync.git", "path": "plugin", "ref": "v<version>"}`.
- Claude Code never runs a build. So the built bundles (`plugin/dist/*.js`) and copies of `LICENSE.md` and `README.md` are
  committed only in the release commit, which the tag points at. On `main` they are ignored (`.gitignore`).
- `plugin.json`'s `version` decides when users get an update. Users stay on the cached copy until that string changes.

## Release v0.1.0-preview

Use a clean clone of the repository, with Node.js 20.6 or newer and git 2.43 or newer. Run every command from the
repository root.

1. Start from `main` with the release work merged, and check it:

   ```sh
   git switch main
   git pull --ff-only
   npm ci
   npm run ci
   ```

2. Make the release commit on its own branch. It must never be merged into `main`.

   ```sh
   git switch -c release/v0.1.0-preview
   npm run build:plugin
   git add -f plugin/dist plugin/LICENSE.md plugin/README.md
   git commit -m "release: cowork-sync v0.1.0-preview plugin build"
   ```

   `npm run build:plugin` (`tools/release/stage-plugin.mjs`) checks that `plugin.json` and `package.json` carry the same version
   and that `plugin/` holds no lockfile. It then builds the bundles into `plugin/dist/`, copies `LICENSE.md` and `README.md` into
   `plugin/`, and runs `plugin/dist/cli.js --version`.

3. Check the plugin the way Claude Code loads it:

   ```sh
   claude plugin validate ./plugin
   claude plugin validate .
   ```

   Then try it in a test clone, with a remote you can push to. Start Claude Code there with
   `claude --plugin-dir <this repository>/plugin`, and run `/cowork-sync:cowork help`, `/cowork-sync:cowork start`,
   `/cowork-sync:cowork status` and `/cowork-sync:cowork stop`.

4. Tag the release commit and push the tag. The tag is the `ref` in the catalog:

   ```sh
   git tag -a v0.1.0-preview -m "cowork-sync v0.1.0-preview"
   git push origin v0.1.0-preview
   git push origin release/v0.1.0-preview
   ```

   Pushing the branch is optional. The tag is what the catalog uses.

5. Publish the catalog. `main` already carries `.claude-plugin/marketplace.json` with `"ref": "v0.1.0-preview"`, so push `main`
   only after the tag exists:

   ```sh
   git switch main
   git push origin main
   ```

   The repository must be public. Claude Code fetches the catalog from the default branch and clones the tag without
   credentials.

   Optionally, pin the exact commit too. Add `"sha": "<the output of git rev-parse v0.1.0-preview^{commit}>"` to the entry's
   `source` on `main`, then commit and push.

6. Check the install from a Claude Code session that has never had the plugin:

   ```text
   /plugin marketplace add Kingyoungmins/cowork-sync
   /plugin install cowork-sync@cowork-sync
   /reload-plugins
   /cowork-sync:cowork help
   ```

## Later releases

1. Change the version in all of these places: `package.json`, both `"version"` fields at the top of `package-lock.json`,
   `src/version.ts`, and `plugin/.claude-plugin/plugin.json`. `test/unit/version.test.ts` and `test/unit/plugin.test.ts` check
   that they agree. After every `PLUGIN_VERSION` bump, re-run `node --import tsx tools/viz/storyboard.ts` and commit the
   regenerated `src/viz/demo/plan2.jsonl`: the viewer's bundled demo embeds the plugin version, so its
   `node --import tsx tools/viz/storyboard.ts --check` (and `test/integration/viz/storyboard.test.ts`, which runs it in CI) fails
   otherwise.
2. Set the catalog entry's `ref` to the new tag (`.claude-plugin/marketplace.json`). Update or drop the `sha` if one is set.
3. Repeat steps 1 to 6 above with the new version.

Users who have not turned on auto-update get the new version with `/plugin marketplace update cowork-sync`, followed by
`claude plugin update cowork-sync@cowork-sync`.

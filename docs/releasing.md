# Release Exam Runtime

Pushing a new stable version tag (`vMAJOR.MINOR.PATCH`) starts [the release workflow](../.github/workflows/release.yml). It checks that the tag matches the root `package.json` and points to a commit on `main`. It runs the tests, builds the npm tarball, and checks the packaged CLI outside the source workspace. It then uses npm Trusted Publishing to publish `exam-runtime-mcp` and creates the GitHub release with the same tarball attached. Pushing `main` alone does not publish anything.

## One-time npm setup

After this workflow is on GitHub, open [the npm package settings](https://www.npmjs.com/package/exam-runtime-mcp/access) and add a **GitHub Actions** trusted publisher:

| Setting | Value |
| --- | --- |
| Organization or user | `nmdra` |
| Repository | `exam-simulator-mcp` |
| Workflow filename | `release.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable **Allow npm publish** |

Approve the change using npm two-factor authentication. With an npm CLI that supports `npm trust`, you can configure the same relationship in an interactive terminal:

```sh
npm trust github exam-runtime-mcp --repo nmdra/exam-simulator-mcp \
  --file release.yml --allow-publish
```

Run the first successful workflow within two days of saving the publisher. No npm token secret is needed. GitHub is private, so npm does not generate public provenance for this package.

## Cut a release

1. On your release branch, bump the root package version and lockfile, for example `npm version patch --no-git-tag-version --workspaces=false`. The workspace package versions are internal and do not need to change.
2. Review, commit, and merge the version change into `main`. Push `main` before pushing the tag.
3. Tag the merged commit and push just that tag. For example, after bumping to `0.1.1`:

   ```sh
   git tag -a v0.1.1 -m 'Release v0.1.1' <main-commit-sha>
   git push origin refs/tags/v0.1.1
   ```

4. Check the **Release Exam Runtime** run. Verify both the [npm version](https://www.npmjs.com/package/exam-runtime-mcp) and the [GitHub release](https://github.com/nmdra/exam-simulator-mcp/releases).

If npm authorization fails, finish the trusted publisher setup and rerun the failed jobs. A retry skips an npm version or GitHub release only if it already has the exact same tarball. If an existing version differs, publish with a new version rather than overwriting or moving a release tag.

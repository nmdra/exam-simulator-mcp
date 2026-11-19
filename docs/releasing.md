# Release Exam Runtime

When you push a new stable version tag (`vMAJOR.MINOR.PATCH`), [the release workflow](../.github/workflows/release.yml) starts. The workflow checks that the tag matches the version in the root `package.json`. The workflow also checks that the tag points to a commit on `main`. It runs the tests and builds the npm tarball. It checks the packaged MCP server over stdio from outside the source workspace. It then uses npm Trusted Publishing to publish `exam-runtime-mcp`. It creates the GitHub release and attaches the same tarball. Pushing only `main` does not publish the npm package or create a GitHub release.

## One-time npm setup

After the workflow is on GitHub, open [the npm package settings](https://www.npmjs.com/package/exam-runtime-mcp/access). Add a **GitHub Actions** trusted publisher:

| Setting | Value |
| --- | --- |
| Organization or user | `nmdra` |
| Repository | `exam-simulator-mcp` |
| Workflow filename | `release.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable **Allow npm publish** |

Approve the change with npm two-factor authentication. If your npm CLI supports `npm trust`, you can also configure the trusted publisher in an interactive terminal:

```sh
npm trust github exam-runtime-mcp --repo nmdra/exam-simulator-mcp \
  --file release.yml --allow-publish
```

Complete the first successful workflow run within two days after you save the trusted publisher. You do not need an npm token secret. The GitHub repository is private. Thus, npm does not generate public provenance for this package.

## Cut a release

1. On your release branch, update the root package version and lockfile. For example, use `npm version patch --no-git-tag-version --workspaces=false`. You do not need to change the internal workspace package versions.
2. Review the version change. Commit the change and merge it into `main`. Push `main` before you push the tag.
3. Tag the merged commit. Push only that tag. For example, after you update the version to `0.1.1`:

   ```sh
   git tag -a v0.1.1 -m 'Release v0.1.1' <main-commit-sha>
   git push origin refs/tags/v0.1.1
   ```

4. Check the **Release Exam Runtime** run. Verify both the [npm version](https://www.npmjs.com/package/exam-runtime-mcp) and the [GitHub release](https://github.com/nmdra/exam-simulator-mcp/releases).

If npm authorization fails, complete the trusted publisher setup. Run the failed jobs again. A retry skips an existing npm version or GitHub release only if the tarballs are identical. If the tarball for an existing version differs, publish a new version. Do not overwrite or move a release tag.

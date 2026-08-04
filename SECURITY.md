# Security

## Reporting a vulnerability

Report privately through [GitHub's private vulnerability reporting][advisories] on this
repository — Security → Report a vulnerability. That keeps the report and the fix in one place
and does not disclose the issue before a release exists.

If you cannot use GitHub, email `info@pixelstech.net`.

Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a few days. Once a fix is released, you will be credited in the
advisory unless you prefer otherwise.

[advisories]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## What this tool does to a browser

ext-tester exists to remove restrictions that normally stop an extension being loaded
automatically. That is the point of it, and it is worth understanding before running it anywhere
that matters.

**It disables an extension-loading protection.** Every run passes
`--disable-features=DisableLoadExtensionCommandLineSwitch` alongside `--load-extension`. Stable
Chrome ignores `--load-extension` deliberately, because silently side-loading an extension is a
known attack. ext-tester turns that guard off for the browser it launches.

**It opens a DevTools endpoint.** `--remote-debugging-port=0` binds a random port on loopback for
the life of the run, used to capture service-worker startup errors and redirect downloads. Anyone
who can run code on the machine can drive that browser while it is open. Disable it by passing
`debugPort: false` through the library API, at the cost of losing worker startup logs.

**It runs the extension's code.** Loading an extension executes its service worker and content
scripts. Do not point ext-tester at an extension you have not read.

Because of all three, run it against a profile and a machine you would be comfortable throwing
away. Every run uses a fresh temporary profile by default and deletes it afterwards; nothing
touches your real browser profile.

## What ends up in a report

Reports are written to capture what happened, which means they can capture more than you intend:

- **Screenshots** of every interactive step, including any page that was open — logged-in
  sessions, tokens visible in a UI, personal data on a test page.
- **Console output** from the page, popup, options page and service worker, which frequently
  contains request bodies and tokens an extension logged while debugging.
- **Downloads** produced by the extension, saved verbatim.
- **`results.json`** containing the values returned by `eval` steps.

`report.html` inlines screenshots as base64, so it carries that content with it when shared.

Treat `ext-test-results/` as sensitive. It is gitignored by default. Think before attaching it to
a public issue or uploading it as a CI artifact on a public repository.

## Supported versions

Until 1.0, fixes land on the latest minor release only.

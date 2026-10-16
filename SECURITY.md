# Security

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://github.com/seriouslysean/openclaw-context-pacer/security/advisories/new). That opens a draft advisory that only you and the maintainer can see. Don't open a public issue.

The link works only while private vulnerability reporting is enabled under Settings → Advanced Security. If the page isn't available, the setting is off. A public issue saying so, without describing what you found, is enough to get it turned on.

This is a solo project, so there's no response-time commitment.

## What's in scope

The plugin sees untrusted web content and, with offload on, writes files where an agent can read them. In scope is anything that:
- **Writes outside the folder it should:** a saved file landing outside `<workspace>/<offload.directory>`, following a symlink, or overwriting an existing file.
- **Deletes the wrong thing:** cleanup removing a folder the plugin didn't create.
- **Drops the untrusted-content label:** external content reaching the model, or a saved file, without OpenClaw's warning and markers.
- **Shows the wrong agent's data:** a result changed for an agent that isn't listed in `agents`.
- **Fails closed:** an error that replaces a tool result instead of leaving it unchanged.

## What isn't

- **Someone who can already write to the agent's workspace or the OpenClaw config.** They already control the agent, and nothing this plugin does changes that.
- **Prompt injection in fetched pages.** That's an OpenClaw and model concern. The plugin's job is to keep the label on, not to judge content.

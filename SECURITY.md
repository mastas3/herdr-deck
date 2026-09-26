# Security

herdr deck can read your agents' conversations and type into their terminals, so its access checks matter.
How they work is described under **Security** in the [README](README.md#security).

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and
what an attacker could do with it. You'll get a reply within a week.

In scope: anything that lets someone other than the machine's owner reach the deck or act through it (over
the network, the tailnet, a browser page, DNS rebinding, the MCP endpoint, or the hub-to-node tunnel), or that
leaks tokens, transcripts or files.

# Managed helper ZIP extraction

Windows fd/rg ZIP assets use the local `extractToolZip` helper, not extract-zip.
The entire central directory is validated before any member is published. Only
ordinary files/directories are accepted. Links, special/encrypted entries,
traversal, Windows aliases, duplicate destinations and file/ancestor collisions
are rejected. Files stream into an existing empty staging directory with exclusive
writes. The existing download/staging cleanup and executable version check remain.
The tar.gz branch is unchanged.

Measured official Windows fd10.5.1/rg15.2.0 assets contain14/16 entries and at most
1.8MiB compressed/4.7MiB expanded. Explicit small-tool budgets are16MiB ZIP,
64MiB total expanded bytes and256 members. Declared sizes are checked before
writing and streamed bytes are checked against declared size. These are not a
general archive service policy or authentication of an upstream release.

Root-owned clean staging and trusted local process ownership remain assumptions;
this is not an OS sandbox against a malicious concurrent local user. Downloaded
archives are never used as filesystem links. Invalid late metadata leaves the
staging empty. I/O corruption/failure during extraction may leave staging files,
which the existing caller removes; a binary is promoted only after extraction
and then must pass its normal version check.

No symlink-dependent helper layout is supported. Normal current official assets
were extracted and compared byte-for-byte in external verification, without
executing or installing those downloaded release binaries. The unit suite creates
ordinary fd/rg-style layouts and malicious late-member fixtures locally, with no
network/provider credentials.

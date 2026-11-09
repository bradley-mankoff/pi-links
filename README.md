# pi-links

Links in pi replies: each real Bead id becomes a terminal link to that Bead on the Beads board.

The board's port is the `BEADS_BOARD_PORT` environment variable, and 3917 when it is unset.

Moved out of the Factory (github.com/bradley-mankoff/factory) at its commit 9aaed8d on 2026-11-08, because pi extensions and herdr plugins are tools of the Human's own setup rather than parts of the Factory (Factory Bead fac-qpv.8). The Factory installs it as a dependency.

Install: `pi install git:github.com/bradley-mankoff/pi-links`

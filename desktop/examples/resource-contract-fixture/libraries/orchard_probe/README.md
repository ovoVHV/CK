# Orchard probe resource contract fixture

This is a third-party V2 package fixture, not a real sensor driver. Its native helper returns the address unchanged and does not access hardware.

Connect a Number literal (for example 60) to ADDRESS. BUS stores the stable resource alias `sensor-port`, not its translated dropdown label. The optional `hardware.claims` declaration resolves that field and input through CK's shared resource contract.

Two instances with distinct addresses share one declared bus. Two instances with the same address conflict. A variable/expression input remains unresolved and reduces analysis coverage.

The package can be validated independently and is bundled in the accompanying board archive solely to exercise the real atomic board-plus-library installer in isolated test roots. It does not require any built-in board ID.

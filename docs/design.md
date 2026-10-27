# Design

Mockup canvases (Claude design artifacts):
- Brand & mascot: https://claude.ai/artifact/82KuApZKdKUFAEaMhu4iTW
- Landing page: https://claude.ai/artifact/8VE9qnyFsJVaqygyqGX8hy (current: **Invite only · default**)
- PWA · desktop & tablet: https://claude.ai/artifact/XabbtUjnArYZ4ZvvMDmYhb
- PWA · phone: https://claude.ai/artifact/8HgV5aFTMa7aP2t7wj8rrf
- Admin portal: https://claude.ai/artifact/HvYtwxSk7QXswK4Yp8xVrt

The decisions log, plan limits and security recommendations are in the Zephyr project doc
"Zephyr_Design_Decisions.md".

## System

- Cool neutral greys, one cobalt accent (`#2D5FD3` light / `#8DB0FF` dark), Geist + Geist Mono (self-hosted).
- Light and dark follow the system setting.
- Mascot: Zephyr the rabbit, in empty states, onboarding, errors, the hero and the passcode screen — never next to
  a client's photos or in the editor canvas.
- Motion: the final layout is the markup; scroll scenes play on top with GSAP and stop for reduced motion.
- Sample scenes are illustrated placeholders. Replace them with licensed photos (your own shoots) before launch.

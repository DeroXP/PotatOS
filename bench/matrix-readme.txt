# The configs behind the README's performance table (4-vCPU host, nothing else running).
# potatos:v1 = PotatOS v1 (git 807f380), potatos:v2 = this tree; build both, then
#   PORT=6300 ./run-matrix.sh matrix-readme.txt 2 readme.jsonl && node summarize.mjs readme.jsonl
# No-viewer / frozen rows: noviewer.sh (see the bench README).

# v1 (balanced default) vs v2 (auto default, balanced, ultra); --cpus 2 / 4; 720p / 1080p (+1440p ultra@4)
# workloads: idle no client (viewport none), idle visible static tab, motion (term + anim)
v1-bal-c2-idle       --image potatos:v1 --cpus 2 --profile balanced --viewport none --workload none
v2-auto-c2-idle      --image potatos:v2 --cpus 2 --profile auto --viewport none --workload none
v2-bal-c2-idle       --image potatos:v2 --cpus 2 --profile balanced --viewport none --workload none
v2-ultra-c2-idle     --image potatos:v2 --cpus 2 --profile ultra --viewport none --workload none
v1-bal-c4-idle       --image potatos:v1 --cpus 4 --profile balanced --viewport none --workload none
v2-auto-c4-idle      --image potatos:v2 --cpus 4 --profile auto --viewport none --workload none
v2-bal-c4-idle       --image potatos:v2 --cpus 4 --profile balanced --viewport none --workload none
v2-ultra-c4-idle     --image potatos:v2 --cpus 4 --profile ultra --viewport none --workload none
v1-bal-c2-720-static   --image potatos:v1 --cpus 2 --profile balanced --viewport 1280x720 --workload static
v2-auto-c2-720-static  --image potatos:v2 --cpus 2 --profile auto --viewport 1280x720 --workload static
v2-bal-c2-720-static   --image potatos:v2 --cpus 2 --profile balanced --viewport 1280x720 --workload static
v2-ultra-c2-720-static --image potatos:v2 --cpus 2 --profile ultra --viewport 1280x720 --workload static
v1-bal-c2-720-motion   --image potatos:v1 --cpus 2 --profile balanced --viewport 1280x720 --workload motion
v2-auto-c2-720-motion  --image potatos:v2 --cpus 2 --profile auto --viewport 1280x720 --workload motion
v2-bal-c2-720-motion   --image potatos:v2 --cpus 2 --profile balanced --viewport 1280x720 --workload motion
v2-ultra-c2-720-motion --image potatos:v2 --cpus 2 --profile ultra --viewport 1280x720 --workload motion
v1-bal-c2-1080-static   --image potatos:v1 --cpus 2 --profile balanced --viewport 1920x1080 --workload static
v2-auto-c2-1080-static  --image potatos:v2 --cpus 2 --profile auto --viewport 1920x1080 --workload static
v2-bal-c2-1080-static   --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload static
v2-ultra-c2-1080-static --image potatos:v2 --cpus 2 --profile ultra --viewport 1920x1080 --workload static
v1-bal-c2-1080-motion   --image potatos:v1 --cpus 2 --profile balanced --viewport 1920x1080 --workload motion
v2-auto-c2-1080-motion  --image potatos:v2 --cpus 2 --profile auto --viewport 1920x1080 --workload motion
v2-bal-c2-1080-motion   --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload motion
v2-ultra-c2-1080-motion --image potatos:v2 --cpus 2 --profile ultra --viewport 1920x1080 --workload motion
v1-bal-c4-720-static   --image potatos:v1 --cpus 4 --profile balanced --viewport 1280x720 --workload static
v2-auto-c4-720-static  --image potatos:v2 --cpus 4 --profile auto --viewport 1280x720 --workload static
v2-bal-c4-720-static   --image potatos:v2 --cpus 4 --profile balanced --viewport 1280x720 --workload static
v2-ultra-c4-720-static --image potatos:v2 --cpus 4 --profile ultra --viewport 1280x720 --workload static
v1-bal-c4-720-motion   --image potatos:v1 --cpus 4 --profile balanced --viewport 1280x720 --workload motion
v2-auto-c4-720-motion  --image potatos:v2 --cpus 4 --profile auto --viewport 1280x720 --workload motion
v2-bal-c4-720-motion   --image potatos:v2 --cpus 4 --profile balanced --viewport 1280x720 --workload motion
v2-ultra-c4-720-motion --image potatos:v2 --cpus 4 --profile ultra --viewport 1280x720 --workload motion
v1-bal-c4-1080-static   --image potatos:v1 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
v2-auto-c4-1080-static  --image potatos:v2 --cpus 4 --profile auto --viewport 1920x1080 --workload static
v2-bal-c4-1080-static   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
v2-ultra-c4-1080-static --image potatos:v2 --cpus 4 --profile ultra --viewport 1920x1080 --workload static
v1-bal-c4-1080-motion   --image potatos:v1 --cpus 4 --profile balanced --viewport 1920x1080 --workload motion
v2-auto-c4-1080-motion  --image potatos:v2 --cpus 4 --profile auto --viewport 1920x1080 --workload motion
v2-bal-c4-1080-motion   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload motion
v2-ultra-c4-1080-motion --image potatos:v2 --cpus 4 --profile ultra --viewport 1920x1080 --workload motion
v2-ultra-c4-1440-static --image potatos:v2 --cpus 4 --profile ultra --viewport 2560x1440 --workload static
v2-ultra-c4-1440-motion --image potatos:v2 --cpus 4 --profile ultra --viewport 2560x1440 --workload motion

# eco mode at a 120 fps target, light motion (anim = 60 Hz CSS animation in 40% x 50% of the screen)
eco-off-ultra-c4  --image potatos:v2 --cpus 4 --profile ultra --viewport 1920x1080 --workload anim
eco-on-ultra-c4   --image potatos:v2 --cpus 4 --profile ultra --viewport 1920x1080 --workload anim --env POTATOS_ECO=on --env POTATOS_ECO_SECONDS=2
eco-off-b120-c2   --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload anim --env SELKIES_FRAMERATE=120,8-120
eco-on-b120-c2    --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload anim --env SELKIES_FRAMERATE=120,8-120 --env POTATOS_ECO=on --env POTATOS_ECO_SECONDS=2

# Turbo, VBV cap in CRF mode, app Chromium --disable-gpu (all: no change except Turbo)
st-base     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
st-turbo    --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static --env SELKIES_VIDEO_STREAMING_MODE=true
term-vbv8   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload term
term-vbv2   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload term --env SELKIES_VIDEO_BITRATE=2000,100-1000000
term-vbv30  --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload term --env SELKIES_VIDEO_BITRATE=30000,100-1000000
anim-base   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim
anim-nogpu  --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim --chromiumFlags --disable-gpu

# RAYON_NUM_THREADS (pixelflux 2.1.0 hashes frame bands on a rayon pool; idle workers spin after each wake)
st-c4-base     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
st-c4-ray1     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static --env RAYON_NUM_THREADS=1
mo-c4-base     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload motion
mo-c4-ray1     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload motion --env RAYON_NUM_THREADS=1
mo-c2-base     --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload motion
mo-c2-ray1     --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload motion --env RAYON_NUM_THREADS=1
hid-c2-1080    --image potatos:v2 --cpus 2 --profile balanced --viewport 1920x1080 --workload static --hidden

# client CPU of the HUD (client_cpu_pct)
cst-base       --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
cst-hudoff     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static --env POTATOS_HUD=off
canim-base     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim
canim-hudoff   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim --env POTATOS_HUD=off

# privacy shade up with the stream playing; potatos:v2-cssblur = this tree before the blurred-still shade (build it from the commit before the blurred-still privacy shade)
sh-anim-none   --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim
sh-anim-css    --image potatos:v2-cssblur --cpus 4 --profile balanced --viewport 1920x1080 --workload anim --shaded
sh-anim-still  --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload anim --shaded
sh-st-none     --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static
sh-st-css      --image potatos:v2-cssblur --cpus 4 --profile balanced --viewport 1920x1080 --workload static --shaded
sh-st-still    --image potatos:v2 --cpus 4 --profile balanced --viewport 1920x1080 --workload static --shaded

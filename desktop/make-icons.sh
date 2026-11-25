#!/usr/bin/env bash
# Génère les icônes (barre des menus + application) avec ffmpeg, sans fichier source.
set -euo pipefail
cd "$(dirname "$0")/assets"

# Icône « template » de la barre des menus : anneau + point (macOS la recolore).
for size in 22 44; do
  c=$((size / 2)); r1=$(echo "$size * 0.18" | bc); r2=$(echo "$size * 0.30" | bc); r3=$(echo "$size * 0.40" | bc)
  name=trayTemplate.png; [ "$size" = 44 ] && name=trayTemplate@2x.png
  ffmpeg -v error -y -f lavfi -i "color=c=black@0:s=${size}x${size},format=rgba" -frames:v 1 \
    -vf "geq=r=0:g=0:b=0:a='if(lt(hypot(X-$c+0.5,Y-$c+0.5),$r1),255,if(between(hypot(X-$c+0.5,Y-$c+0.5),$r2,$r3),255,0))'" "$name"
done
# Variante « enregistrement en cours » (point plein, colorée).
ffmpeg -v error -y -f lavfi -i "color=c=black@0:s=44x44,format=rgba" -frames:v 1 \
  -vf "geq=r=239:g=83:b=80:a='if(lt(hypot(X-21.5,Y-21.5),14),255,0)'" trayRec@2x.png
ffmpeg -v error -y -i trayRec@2x.png -vf scale=22:22 trayRec.png

# Icône de la barre des tâches Windows (pas de recoloration par le système) : anneau blanc + point chartreuse.
ffmpeg -v error -y -f lavfi -i "color=c=black@0:s=32x32,format=rgba" -frames:v 1 \
  -vf "geq=r='if(lt(hypot(X-15.5,Y-15.5),6),212,255)':g='255':b='if(lt(hypot(X-15.5,Y-15.5),6),58,255)':a='if(lt(hypot(X-15.5,Y-15.5),6)+between(hypot(X-15.5,Y-15.5),10,14),255,0)'" trayWin.png

# Icône d'application 1024 px : carré arrondi dégradé, anneau et point blancs.
ffmpeg -v error -y -f lavfi -i "color=c=black:s=1024x1024,format=rgba" -frames:v 1 -vf "geq=\
r='if(lt(hypot(X-512,Y-512),150)+between(hypot(X-512,Y-512),250,330),255,20+40*Y/1024)':\
g='if(lt(hypot(X-512,Y-512),150)+between(hypot(X-512,Y-512),250,330),255,60+60*Y/1024)':\
b='if(lt(hypot(X-512,Y-512),150)+between(hypot(X-512,Y-512),250,330),255,140+100*Y/1024)':\
a='if(lte(hypot(max(abs(X-511.5)-312,0),max(abs(Y-511.5)-312,0)),200),255,0)'" icon.png

rm -rf icon.iconset && mkdir icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out icon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) icon.png --out icon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns && rm -rf icon.iconset
echo "icônes générées"

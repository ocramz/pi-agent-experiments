# pi-agent-experiments

Experiments with the Pi coding agent


# Set up

* pull image and start container : 

```bash
docker pull ocramz/pi-container      # or a pinned tag: :0.84.2

docker run --rm -it \
  -v "$PWD":/workspace \
  -v pi-config:/root/.pi \
  -e OPENROUTER_API_KEY:... \
  ocramz/pi-container
```
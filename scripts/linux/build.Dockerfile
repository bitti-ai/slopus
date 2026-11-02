# Match slopfab's glibc baseline, including the libraries linuxdeploy bundles.
FROM nvidia/cuda:13.0.2-devel-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config python3 binutils \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev libxdo-dev libssl-dev file patchelf squashfs-tools \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.99.0 \
    && rm /tmp/rustup.sh
ENV PATH="/root/.cargo/bin:${PATH}"
# Let linuxdeploy resolve the generation library without a physical GPU.
# The deployment plugin removes the driver stub and toolkit libraries.
RUN mkdir -p /opt/cuda-stubs \
    && ln -s /usr/local/cuda/lib64/stubs/libcuda.so /opt/cuda-stubs/libcuda.so.1
ENV LD_LIBRARY_PATH="/opt/cuda-stubs:/usr/local/cuda/lib64:${LD_LIBRARY_PATH}"
WORKDIR /src

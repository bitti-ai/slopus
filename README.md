![Slopus logo](marketing/logo.png)

# Slopus

Slopus is a local-first, agentic desktop application for AI-assisted video creation and editing. It brings video generation, reusable visual references, and a timeline editor into one workspace.

Connect Claude Code, Codex, OpenRouter, or any local model served through an OpenAI-compatible API to drive your creative workflow with natural language. Ask your agent to turn an idea into scenes and shots, build reusable references, and refine your project through conversation.

Describe shots with prompts and references, generate clips locally through the SlopFab engine, then arrange and trim video and audio on the timeline before exporting. Projects live in ordinary folders on your computer, keeping project data, source assets, generated media, and exports together.

The interface is built with React, TypeScript, and Vite, with a Rust backend and Tauri 2 desktop shell. SlopFab powers local AI generation using separately installed model weights and GPU support.

For Slopus, we recommend installing CUDA 13 for NVIDIA GeForce RTX 50 series (Blackwell) GPUs, or CUDA 12.8 for RTX 30 and RTX 40 series GPUs. AMD GPUs use the Vulkan backend, which also serves as the fallback for NVIDIA GPUs when CUDA is not installed.

Powered by MiniMax H3. MiniMax H3 model weights are licensed separately under their own MiniMax H3 COMMUNITY LICENSE AGREEMENT.

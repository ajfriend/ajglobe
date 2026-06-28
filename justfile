# ajglobe tasks. Run `just` to list.

# default: show available recipes
default:
    @just --list

# Serve the repo and open the ivea7h r5/r6 torture test (the acceptance test).
# Ctrl-C to stop. See PLAN.md §8/§9.
test port="8080":
    @echo "→ http://localhost:{{port}}/examples/dggs-globe.html"
    uv run -m http.server {{port}} -d {{justfile_directory()}}

# Run the geometry unit tests (Node's built-in runner; zero deps).
unit:
    node --test

# Build the dist/ bundles (ESM + IIFE, minified). One-time setup: `npm install`.
build:
    npm run build

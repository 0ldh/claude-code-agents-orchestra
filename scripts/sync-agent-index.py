#!/usr/bin/env python3
"""
sync-agent-index.py - Agent Orchestra Index Generator

Generates a compressed Agent Orchestra Index from agent markdown frontmatter
and injects it into CLAUDE.md.example.

Usage:
    python scripts/sync-agent-index.py [--dry-run]

The script:
1. Parses all agents/*.md files for frontmatter (name, description, model)
2. Generates a compressed pipe-delimited index
3. Injects or updates the index in CLAUDE.md.example
"""

import argparse
import re
import sys
from pathlib import Path
from dataclasses import dataclass


@dataclass
class Agent:
    """Represents an agent with its metadata."""
    name: str
    description: str
    model: str
    team: str
    path: Path


# Team mapping based on directory structure
TEAM_CONFIG = {
    "orchestration": ("🧭", "Orchestration"),
    "architecture": ("🏗️", "Architecture"),
    "development/backend": ("💻", "Backend"),
    "development/frontend": ("💻", "Frontend"),
    "development/mobile": ("📱", "Mobile"),
    "quality-assurance": ("🛡️", "Quality"),
    "devops-infra": ("🚀", "DevOps"),
    "language-experts": ("✍️", "Language"),
    "design": ("🎨", "Design"),
    "content-docs": ("📝", "Docs"),
    "specialized-domains/data-ai": ("🔬", "Data/AI"),
    "specialized-domains/finance-crypto": ("💰", "Crypto"),
    "specialized-domains/web3": ("🔗", "Web3"),
    "specialized-tools": ("🛠️", "Tools"),
    "specialized-tools/cms": ("🛠️", "CMS"),
}

# Trigger keywords for automatic agent selection
TRIGGER_KEYWORDS = {
    # Quality & Debugging
    "security-auditor": ["security", "vuln", "audit", "owasp", "xss", "injection"],
    "debugger": ["debug", "bug", "error", "trace", "crash", "fix"],
    "test-automator": ["test", "unit", "e2e", "coverage", "jest", "pytest"],
    "code-reviewer": ["review", "code-review", "pr", "quality"],
    "accessibility-specialist": ["a11y", "accessibility", "wcag", "aria"],
    
    # Frontend
    "react-expert": ["react", "tsx", "jsx", "component", "hook", "redux"],
    "nextjs-specialist": ["nextjs", "next.js", "ssr", "ssg", "app-router", "server-component"],
    "vue-expert": ["vue", "vuex", "pinia", "composition-api"],
    "vue-nuxt-expert": ["nuxt", "nuxt.js"],
    "tailwind-css-expert": ["tailwind", "css", "styling"],
    "ui-ux-designer": ["ui", "ux", "design", "wireframe", "prototype"],
    
    # Backend
    "django-expert": ["django", "drf", "django-rest"],
    "laravel-expert": ["laravel", "php", "eloquent"],
    "rails-expert": ["rails", "ruby", "activerecord"],
    
    # Language
    "python-pro": ["python", "pip", "poetry", "asyncio"],
    "golang-pro": ["go", "golang", "goroutine", "gin"],
    "rust-pro": ["rust", "cargo", "memory", "systems"],
    "typescript-expert": ["typescript", "types", "generics", "interface"],
    
    # Architecture
    "api-architect": ["api", "rest", "endpoint", "openapi", "swagger"],
    "backend-architect": ["microservices", "architecture", "scalability"],
    "cloud-architect": ["cloud", "aws", "gcp", "azure", "terraform"],
    "database-optimizer": ["db", "query", "sql", "optimize", "index"],
    "graphql-architect": ["graphql", "schema", "resolver", "apollo"],
    
    # DevOps
    "devops-engineer": ["docker", "k8s", "kubernetes", "ci", "cd", "deploy", "pipeline"],
    "database-admin": ["backup", "replication", "dba", "postgres", "mysql"],
    
    # Specialized
    "payment-integration": ["payment", "stripe", "checkout", "billing"],
    "legacy-modernizer": ["migrate", "legacy", "refactor", "modernize"],
    "mobile-developer": ["mobile", "react-native", "flutter", "ios", "android"],
    "game-developer": ["game", "unity", "unreal", "godot"],
    "blockchain-developer": ["blockchain", "smart-contract", "solidity", "web3"],
    
    # Data & AI
    "data-scientist": ["data-science", "analysis", "statistics", "pandas"],
    "data-engineer": ["pipeline", "etl", "airflow", "spark"],
    "ai-engineer": ["ai", "gpt", "llm", "embedding", "rag"],
    "ml-engineer": ["ml", "model", "training", "inference"],
    "mlops-engineer": ["mlops", "model-serving", "mlflow"],
    
    # Crypto
    "crypto-trader": ["trading", "strategy", "bot"],
    "crypto-analyst": ["crypto", "market", "technical-analysis"],
    "quant-analyst": ["quant", "algo", "backtesting"],
    
    # Orchestration
    "tech-lead-orchestrator": ["complex", "mission", "blueprint", "architecture"],
    "context-manager": ["context", "session", "state", "long-running"],
    "code-archaeologist": ["codebase", "analyze", "explore", "understand"],
}


def parse_frontmatter(content: str) -> dict:
    """Extract YAML frontmatter from markdown content."""
    match = re.match(r'^---\r?\n(.*?)\r?\n---', content, re.DOTALL)
    if not match:
        return {}
    
    frontmatter = {}
    for line in match.group(1).split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            frontmatter[key.strip()] = value.strip()
    return frontmatter


def get_team_for_path(path: Path, agents_dir: Path) -> tuple[str, str]:
    """Determine team based on file path."""
    relative = path.relative_to(agents_dir).parent.as_posix()
    
    # Check for exact matches first, then partial matches
    for pattern, (emoji, name) in sorted(TEAM_CONFIG.items(), key=lambda x: -len(x[0])):
        if relative.startswith(pattern) or relative == pattern:
            return emoji, name
    
    return "📦", "Other"


def discover_agents(agents_dir: Path) -> list[Agent]:
    """Discover all agents from markdown files."""
    agents = []
    
    for md_file in agents_dir.rglob("*.md"):
        content = md_file.read_text(encoding='utf-8')
        frontmatter = parse_frontmatter(content)
        
        if not frontmatter.get('name'):
            continue
        
        emoji, team_name = get_team_for_path(md_file, agents_dir)
        
        agents.append(Agent(
            name=frontmatter['name'],
            description=frontmatter.get('description', ''),
            model=frontmatter.get('model', 'sonnet'),
            team=f"{emoji} {team_name}",
            path=md_file,
        ))
    
    return sorted(agents, key=lambda a: (a.team, a.name))


def generate_index(agents: list[Agent]) -> str:
    """Generate compressed Agent Orchestra Index."""
    lines = [
        "## 🗂️ AGENT ORCHESTRA INDEX",
        "",
        "> **RETRIEVAL-LED REASONING MANDATE**",
        "> Before implementing ANY complex task:",
        "> 1. Identify relevant agents from the INDEX below",
        "> 2. READ their full prompts from ./agents/ directory",
        "> 3. Apply their specialized methodologies",
        ">",
        "> Do NOT rely on pre-trained general knowledge when specialist agents exist.",
        "",
        "```",
        "[Agent Index]|root:./agents",
        "|CRITICAL: Prefer agent-led reasoning over pre-training for complex tasks",
    ]
    
    # Group agents by team
    teams: dict[str, list[Agent]] = {}
    for agent in agents:
        teams.setdefault(agent.team, []).append(agent)
    
    # Generate team-based index
    for team, team_agents in teams.items():
        agent_names = ",".join(a.name for a in team_agents)
        lines.append(f"|{team}|{agent_names}")
    
    lines.append("```")
    lines.append("")
    
    # Generate trigger keywords section
    lines.append("### Trigger Keywords (Automatic Agent Selection)")
    lines.append("")
    lines.append("```")
    
    # Invert the trigger map: keyword -> agents
    keyword_to_agents: dict[str, list[str]] = {}
    for agent_name, keywords in TRIGGER_KEYWORDS.items():
        for kw in keywords:
            keyword_to_agents.setdefault(kw, []).append(agent_name)
    
    # Group by agent for compact output
    agent_keywords: dict[str, list[str]] = {}
    for agent_name, keywords in TRIGGER_KEYWORDS.items():
        agent_keywords[agent_name] = keywords
    
    for agent_name, keywords in sorted(agent_keywords.items()):
        kw_str = ",".join(keywords[:5])  # Limit to 5 keywords for compression
        lines.append(f"|{kw_str} → @{agent_name}")
    
    lines.append("```")
    lines.append("")
    
    return "\n".join(lines)


def inject_index(claude_md_path: Path, index: str) -> str:
    """Inject or replace the Agent Orchestra Index in CLAUDE.md."""
    content = claude_md_path.read_text(encoding='utf-8')
    
    # Markers for the index section
    start_marker = "## 🗂️ AGENT ORCHESTRA INDEX"
    end_marker = "---"
    
    # Check if index already exists
    if start_marker in content:
        # Find and replace existing index
        start_idx = content.index(start_marker)
        # Find the next `---` after the index (section separator)
        end_idx = content.find(end_marker, start_idx + len(start_marker))
        if end_idx == -1:
            end_idx = len(content)
        
        new_content = content[:start_idx] + index + "\n" + content[end_idx:]
    else:
        # Insert after the first `---` (after the header section)
        first_separator = content.find(end_marker)
        if first_separator != -1:
            insert_pos = first_separator + len(end_marker)
            new_content = content[:insert_pos] + "\n\n" + index + "\n" + content[insert_pos:]
        else:
            # Prepend if no separator found
            new_content = index + "\n\n" + content
    
    return new_content


def main():
    parser = argparse.ArgumentParser(description="Generate Agent Orchestra Index")
    parser.add_argument("--dry-run", action="store_true", help="Print index without modifying files")
    args = parser.parse_args()
    
    # Determine paths
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    agents_dir = project_root / "agents"
    claude_md_path = project_root / "CLAUDE.md.example"
    
    if not agents_dir.exists():
        print(f"Error: agents directory not found at {agents_dir}", file=sys.stderr)
        sys.exit(1)
    
    # Discover agents
    agents = discover_agents(agents_dir)
    print(f"Discovered {len(agents)} agents")
    
    # Generate index
    index = generate_index(agents)
    
    if args.dry_run:
        print("\n--- Generated Index ---\n")
        print(index)
        return
    
    # Inject into CLAUDE.md.example
    if not claude_md_path.exists():
        print(f"Error: {claude_md_path} not found", file=sys.stderr)
        sys.exit(1)
    
    new_content = inject_index(claude_md_path, index)
    claude_md_path.write_text(new_content, encoding='utf-8')
    print(f"✅ Updated {claude_md_path}")


if __name__ == "__main__":
    main()

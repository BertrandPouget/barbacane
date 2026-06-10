# Graph Report - .  (2026-06-10)

## Corpus Check
- Large corpus: 101 files � ~3,311,026 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 502 nodes · 1238 edges · 33 communities (20 shown, 13 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 136 edges (avg confidence: 0.54)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Turn Action System|Turn Action System]]
- [[_COMMUNITY_Database & Persistence|Database & Persistence]]
- [[_COMMUNITY_Card Registry & Models|Card Registry & Models]]
- [[_COMMUNITY_Game Engine & Turn Flow|Game Engine & Turn Flow]]
- [[_COMMUNITY_Battle Resolution|Battle Resolution]]
- [[_COMMUNITY_Project Overview & Assets|Project Overview & Assets]]
- [[_COMMUNITY_Game Configuration & Rules|Game Configuration & Rules]]
- [[_COMMUNITY_Warrior & Field Effects|Warrior & Field Effects]]
- [[_COMMUNITY_Passive & Deferred Effects|Passive & Deferred Effects]]
- [[_COMMUNITY_Core Effect Registry|Core Effect Registry]]
- [[_COMMUNITY_Building & Horde Effects|Building & Horde Effects]]
- [[_COMMUNITY_WebSocket & Connections|WebSocket & Connections]]
- [[_COMMUNITY_Horde Activations|Horde Activations]]
- [[_COMMUNITY_Draw & Search Effects|Draw & Search Effects]]
- [[_COMMUNITY_Frontend App UI|Frontend App UI]]
- [[_COMMUNITY_Card Data Schema|Card Data Schema]]
- [[_COMMUNITY_Recruit Search Effect|Recruit Search Effect]]
- [[_COMMUNITY_Enemy Recruit Control|Enemy Recruit Control]]
- [[_COMMUNITY_Decumano Building Effect|Decumano Building Effect]]
- [[_COMMUNITY_Eracle Horde Bonus|Eracle Horde Bonus]]
- [[_COMMUNITY_Evelyn Spell Duplication|Evelyn Spell Duplication]]
- [[_COMMUNITY_Giulio II Search Effect|Giulio II Search Effect]]
- [[_COMMUNITY_Battle Range Effect|Battle Range Effect]]
- [[_COMMUNITY_Madeleine Prodigy Effect|Madeleine Prodigy Effect]]
- [[_COMMUNITY_Reinhold Cost Reduction|Reinhold Cost Reduction]]
- [[_COMMUNITY_Sorgiva Building Effect|Sorgiva Building Effect]]
- [[_COMMUNITY_Vitalflusso Life Effect|Vitalflusso Life Effect]]
- [[_COMMUNITY_Frontend Renderer|Frontend Renderer]]
- [[_COMMUNITY_WebSocket Client|WebSocket Client]]

## God Nodes (most connected - your core abstractions)
1. `Player` - 59 edges
2. `GameState` - 56 edges
3. `ActionError` - 45 edges
4. `WarriorInstance` - 40 edges
5. `GameState` - 37 edges
6. `Player` - 35 edges
7. `get_card()` - 33 edges
8. `_dispatch_action()` - 29 edges
9. `BuildingInstance` - 26 edges
10. `get_base_card_id()` - 24 edges

## Surprising Connections (you probably didn't know these)
- `Barbacane Project Overview` --references--> `Background Texture — Warm Orange Plastered Brick Wall`  [INFERRED]
  CLAUDE.md → assets/background.png
- `Action Pipeline (app.js → WebSocket → routes → actions → effects → storage → broadcast)` --semantically_similar_to--> `Multiplayer WebSocket Flow`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Search Mechanic (look through deck, take card, shuffle)` --semantically_similar_to--> `Test Mode (player name Test/Test2)`  [INFERRED] [semantically similar]
  assets/rules.md → CLAUDE.md
- `Frontend index.html — SPA Shell` --references--> `Logo Color — Barbacane Yellow Cartoon Lettering`  [EXTRACTED]
  frontend/index.html → assets/logo_color.png
- `GameState` --uses--> `GameState`  [INFERRED]
  db/storage.py → engine/models.py

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Full Player Action Pipeline (Frontend → WebSocket → Server → Storage → Broadcast)** — readme_action_pipeline, claude_multiplayer_flow, frontend_game_screen, claude_public_state, claude_sqlite_schema [INFERRED 0.90]
- **Card Effect System (Registry + Types + Pre-validation + Trigger Moments)** — claude_effect_registry_pattern, rules_card_types, claude_spell_prevalidation, rules_horde_mechanic, rules_prodigy_mechanic [INFERRED 0.85]
- **Visual Identity Assets (backgrounds + logos used in frontend)** — assets_background_png, assets_cracked_background_png, assets_logo_color_png, assets_logo_gold_png [EXTRACTED 0.95]

## Communities (33 total, 13 thin omitted)

### Community 0 - "Turn Action System"
Cohesion: 0.09
Nodes (67): ActionError, activate_horde(), add_wall(), arena_activate(), complete_building(), discard_card(), discard_wall(), eracle_destroy() (+59 more)

### Community 1 - "Database & Persistence"
Cohesion: 0.06
Nodes (47): get_conn(), get_db_path(), get_game_status(), get_player_by_token(), get_players_for_game(), init_db(), load_game(), load_game_by_lobby() (+39 more)

### Community 2 - "Card Registry & Models"
Cohesion: 0.07
Nodes (51): BaseModel, load_cards(), CardDef, Caricamento e registro delle carte da cards.json. CARD_REGISTRY mappa base_card, Carica tutte le carte dal JSON e popola CARD_REGISTRY., build_deck(), build_instance_registry(), discard_from_hand() (+43 more)

### Community 3 - "Game Engine & Turn Flow"
Cohesion: 0.07
Nodes (56): draw_cards(), draw_to_hand_limit(), Pesca `count` carte dal mazzo per il giocatore `player_id`.     Se il mazzo è v, Pesca carte fino a raggiungere `limit` carte in mano (senza scartare l'eccesso)., _apply_battle_bonuses(), _available_hordes(), _begin_turn(), _bot_reposition() (+48 more)

### Community 4 - "Battle Resolution"
Cohesion: 0.07
Nodes (36): ActionError, adjacent_bastions(), apply_damage_to_bastion(), attacker_stats(), calculate_damage(), defender_stats(), _effective_att(), _effective_dif() (+28 more)

### Community 5 - "Project Overview & Assets"
Cohesion: 0.07
Nodes (38): Background Texture — Warm Orange Plastered Brick Wall, Cracked Background Texture — Orange Brick with Glowing Yellow Cracks, Logo Color — Barbacane Yellow Cartoon Lettering, Logo Gold — Barbacane Ornate Metallic Gold Lettering, Barbacane Project Overview, Effect Registry Pattern, Ethereal Card Mechanic, Instance ID Convention (+30 more)

### Community 6 - "Game Configuration & Rules"
Cohesion: 0.07
Nodes (29): battle, adjacency, deck, buildings, spells, total_cards, warriors, game (+21 more)

### Community 7 - "Warrior & Field Effects"
Cohesion: 0.12
Nodes (20): arena_effect(), arrampicarta_effect(), cambiamente_effect(), _discard_warrior_from_player(), equipotenza_effect(), _find_warrior_in_all(), _is_hero(), malcomune_effect() (+12 more)

### Community 8 - "Passive & Deferred Effects"
Cohesion: 0.11
Nodes (18): divinazione_effect(), faust_horde(), fossato_effect(), granaio_effect(), incendifesa_effect(), magiscudo_effect(), plasmarmo_effect(), GameState (+10 more)

### Community 9 - "Core Effect Registry"
Cohesion: 0.14
Nodes (16): _add_walls_to_bastion(), _apply_scrigno_bonus(), ardolancio_effect(), estrattore_effect(), fucina_effect(), investimento_effect(), Registry degli effetti delle carte. Ogni effetto è una funzione registrata trami, Base: roll D10, se ≥6 gain +1 mana. Complete: gain +1 mana automaticamente. (+8 more)

### Community 10 - "Building & Horde Effects"
Cohesion: 0.12
Nodes (17): araminta_horde(), ariete_effect(), bastioncontrario_effect(), cardo_effect(), catapulta_effect(), dazipazzi_effect(), decimo_horde(), obelisco_effect() (+9 more)

### Community 11 - "WebSocket & Connections"
Cohesion: 0.15
Nodes (6): ConnectionManager, WebSocket, WebSocket Connection Manager per Barbacane. Gestisce le connessioni attive e il, Invia un messaggio a tutti i giocatori connessi nella partita., Invia un messaggio a un singolo giocatore., Avvia il timer per il turno. Allo scadere chiama on_expire_callback(game_id, pla

### Community 12 - "Horde Activations"
Cohesion: 0.20
Nodes (10): _find_warrior(), joseph_horde(), orfeo_horde(), patrizio_horde(), polemarco_horde(), Questa carta ottiene +2 GIT fino al prossimo turno del giocatore., Questa carta ottiene +1 ATT e +1 DIF fino al prossimo turno del giocatore., Questa carta (polemarco) ottiene +1 ATT per ogni Umano in campo. (+2 more)

### Community 13 - "Draw & Search Effects"
Cohesion: 0.40
Nodes (5): agilpesca_effect(), biblioteca_effect(), _draw_cards(), Base: pesca 1 carta, poi scarta 1 carta dalla mano.     Complete: pesca 1 carta,, Base: pesca 2 carte, scarta 1 (risolto via pending_interaction), ottieni 1 Azion

### Community 14 - "Frontend App UI"
Cohesion: 0.50
Nodes (3): App, _copyFallback(), copyLobbyCode()

### Community 15 - "Card Data Schema"
Cohesion: 0.50
Nodes (3): buildings, spells, warriors

## Knowledge Gaps
- **43 isolated node(s):** `warriors`, `spells`, `buildings`, `min_players`, `max_players` (+38 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GameState` connect `Battle Resolution` to `Turn Action System`, `Database & Persistence`, `Card Registry & Models`, `Game Engine & Turn Flow`, `Warrior & Field Effects`, `Passive & Deferred Effects`, `Core Effect Registry`, `Building & Horde Effects`?**
  _High betweenness centrality (0.064) - this node is a cross-community bridge._
- **Why does `Player` connect `Battle Resolution` to `Turn Action System`, `Card Registry & Models`, `Game Engine & Turn Flow`, `Warrior & Field Effects`, `Passive & Deferred Effects`, `Core Effect Registry`, `Building & Horde Effects`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `WarriorInstance` connect `Card Registry & Models` to `Turn Action System`, `Game Engine & Turn Flow`, `Battle Resolution`, `Warrior & Field Effects`, `Passive & Deferred Effects`, `Core Effect Registry`, `Building & Horde Effects`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `Player` (e.g. with `BuildingInstance` and `GameState`) actually correct?**
  _`Player` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 4 inferred relationships involving `GameState` (e.g. with `BuildingInstance` and `GameState`) actually correct?**
  _`GameState` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 13 inferred relationships involving `ActionError` (e.g. with `BuildingInstance` and `GameState`) actually correct?**
  _`ActionError` has 13 INFERRED edges - model-reasoned connections that need verification._
- **Are the 22 inferred relationships involving `WarriorInstance` (e.g. with `ActionError` and `Any`) actually correct?**
  _`WarriorInstance` has 22 INFERRED edges - model-reasoned connections that need verification._
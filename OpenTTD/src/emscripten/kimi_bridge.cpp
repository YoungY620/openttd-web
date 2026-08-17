/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/** @file kimi_bridge.cpp Emscripten-only bridge exposing console execution and a JSON game-state snapshot to JavaScript, driving the in-browser "Kimi" AI player panel. */

#ifdef __EMSCRIPTEN__

#include "../stdafx.h"
#include "../company_base.h"
#include "../company_func.h"
#include "../console_func.h"
#include "../industry.h"
#include "../industrytype.h"
#include "../map_func.h"
#include "../openttd.h"
#include "../station_base.h"
#include "../strings_func.h"
#include "../town.h"
#include "../townname_func.h"
#include "../vehicle_base.h"
#include "table/strings.h"
#include "../timer/timer_game_calendar.h"
#include "../3rdparty/nlohmann/json.hpp"

#include <emscripten.h>

#include <algorithm>
#include <array>
#include <numeric>
#include <string>
#include <vector>

#include "../safeguards.h"

extern "C" {

/**
 * Execute an in-game console command, exactly as if typed into the in-game console.
 * Safe to call while in the main menu or during a running game; commands that
 * require a running game simply fail with a console error message.
 * @param command The command line to execute, e.g. "newgame" or "list_cmds".
 */
void EMSCRIPTEN_KEEPALIVE em_openttd_console(const char *command)
{
	if (command == nullptr) return;
	IConsoleCmdExec(command);
}

/**
 * Get a compact JSON snapshot of the current game state.
 *
 * The returned pointer refers to a static buffer that is invalidated by the
 * next call; the Emscripten side is expected to copy it out (e.g. via
 * UTF8ToString) immediately. Not thread-safe, but the WASM build is
 * single-threaded.
 *
 * When no game is active (main menu / scenario editor) the result still is
 * valid JSON, with "in_game" set to false and only globally available
 * information filled in.
 * @return Pointer to a NUL-terminated UTF-8 JSON document.
 */
const char *EMSCRIPTEN_KEEPALIVE em_openttd_state()
{
	static std::string state;

	nlohmann::json json;

	bool in_game = _game_mode == GameMode::Normal;
	json["in_game"] = in_game;

	/* Globally available information, also valid outside a running game. */
	TimerGameCalendar::YearMonthDay ymd = TimerGameCalendar::ConvertDateToYMD(TimerGameCalendar::date);
	json["date"]["year"] = ymd.year.base();
	json["date"]["month"] = ymd.month + 1;
	json["date"]["day"] = ymd.day;

	json["paused"] = _pause_mode.Any();

	json["map_x"] = Map::SizeX();
	json["map_y"] = Map::SizeY();

	if (in_game) {
		json["local_company"] = Company::IsValidID(_local_company) ? static_cast<int>(_local_company.base()) : -1;

		/* Vehicle and station counts per company, gathered in a single pass each. */
		struct VehicleCounts {
			uint train = 0;
			uint road = 0;
			uint ship = 0;
			uint aircraft = 0;
		};
		std::array<VehicleCounts, MAX_COMPANIES> vehicle_counts{};
		std::array<uint, MAX_COMPANIES> station_counts{};

		for (const Vehicle *v : Vehicle::Iterate()) {
			if (!v->IsPrimaryVehicle()) continue;
			if (v->owner.base() >= MAX_COMPANIES) continue;
			VehicleCounts &counts = vehicle_counts[v->owner.base()];
			switch (v->type) {
				case VehicleType::Train: counts.train++; break;
				case VehicleType::Road: counts.road++; break;
				case VehicleType::Ship: counts.ship++; break;
				case VehicleType::Aircraft: counts.aircraft++; break;
				default: break;
			}
		}

		for (const Station *st : Station::Iterate()) {
			if (st->owner.base() >= MAX_COMPANIES) continue;
			station_counts[st->owner.base()]++;
		}

		nlohmann::json companies = nlohmann::json::array();
		for (const Company *c : Company::Iterate()) {
			nlohmann::json jc;
			jc["index"] = c->index.base();
			jc["name"] = GetString(STR_COMPANY_NAME, c->index);
			jc["money"] = static_cast<int64_t>(c->money);
			jc["current_loan"] = static_cast<int64_t>(c->current_loan);
			jc["company_value"] = static_cast<int64_t>(CalculateCompanyValue(c));
			jc["income"] = static_cast<int64_t>(c->cur_economy.income);
			jc["expenses"] = static_cast<int64_t>(c->cur_economy.expenses);
			jc["delivered_cargo"] = std::accumulate(c->cur_economy.delivered_cargo.begin(), c->cur_economy.delivered_cargo.end(), 0U);
			jc["performance_history"] = c->cur_economy.performance_history;
			jc["is_ai"] = c->is_ai;
			jc["bankrupt"] = c->months_of_bankruptcy > 0;
			jc["vehicles"]["train"] = vehicle_counts[c->index.base()].train;
			jc["vehicles"]["road"] = vehicle_counts[c->index.base()].road;
			jc["vehicles"]["ship"] = vehicle_counts[c->index.base()].ship;
			jc["vehicles"]["aircraft"] = vehicle_counts[c->index.base()].aircraft;
			jc["stations"] = station_counts[c->index.base()];
			companies.push_back(std::move(jc));
		}
		json["companies"] = std::move(companies);

		/* Top 15 towns by population, plus the total town count. */
		std::vector<const Town *> towns;
		towns.reserve(Town::GetNumItems());
		for (const Town *t : Town::Iterate()) towns.push_back(t);
		std::sort(towns.begin(), towns.end(), [](const Town *a, const Town *b) { return a->cache.population > b->cache.population; });

		nlohmann::json jtowns = nlohmann::json::array();
		for (size_t i = 0; i < std::min<size_t>(15, towns.size()); i++) {
			nlohmann::json jt;
			jt["name"] = GetTownName(towns[i]);
			jt["population"] = towns[i]->cache.population;
			jtowns.push_back(std::move(jt));
		}
		json["towns"] = std::move(jtowns);
		json["town_count"] = towns.size();

		/* Up to 30 industries with their type name, plus the total industry count. */
		nlohmann::json industries = nlohmann::json::array();
		size_t industry_listed = 0;
		for (const Industry *ind : Industry::Iterate()) {
			if (industry_listed >= 30) break;
			nlohmann::json ji;
			ji["index"] = ind->index.base();
			ji["type"] = GetString(GetIndustrySpec(ind->type)->name);
			industries.push_back(std::move(ji));
			industry_listed++;
		}
		json["industries"] = std::move(industries);
		json["industry_count"] = Industry::GetNumItems();
	}

	state = json.dump();
	return state.c_str();
}

}

#endif /* __EMSCRIPTEN__ */

/*
 * This file is part of OpenTTD.
 * OpenTTD is free software; you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 2.
 * OpenTTD is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details. You should have received a copy of the GNU General Public License along with OpenTTD. If not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0>.
 */

/** @file kimi_actions.cpp Emscripten-only bridge exposing synchronous gameplay actions (build road, stops, depots, vehicles, orders) as a JSON-in/JSON-out C function, so the in-browser "Kimi" AI player panel can actually play the game. */

#ifdef __EMSCRIPTEN__

#include "../stdafx.h"
#include "../cargo_type.h"
#include "../cargotype.h"
#include "../command_func.h"
#include "../company_base.h"
#include "../company_func.h"
#include "../direction_type.h"
#include "../engine_base.h"
#include "../engine_func.h"
#include "../industry.h"
#include "../industry_map.h"
#include "../industrytype.h"
#include "../map_func.h"
#include "../newgrf_roadstop.h"
#include "../openttd.h"
#include "../order_base.h"
#include "../order_cmd.h"
#include "../order_type.h"
#include "../road_cmd.h"
#include "../road_map.h"
#include "../road_type.h"
#include "../station_base.h"
#include "../station_cmd.h"
#include "../station_map.h"
#include "../station_type.h"
#include "../strings_func.h"
#include "../tile_map.h"
#include "../town.h"
#include "../town_map.h"
#include "../townname_func.h"
#include "../vehicle_base.h"
#include "../vehicle_cmd.h"
#include "table/strings.h"
#include "../timer/timer_game_calendar.h"
#include "../3rdparty/nlohmann/json.hpp"

#include <emscripten.h>

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../safeguards.h"

namespace {

/** Build a standard error response object. */
nlohmann::json ErrorResponse(std::string_view error)
{
	return nlohmann::json{{"ok", false}, {"error", error}};
}

/** Lowercase an ASCII string for case-insensitive matching. */
std::string ToLower(std::string_view str)
{
	std::string result(str);
	for (char &c : result) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
	return result;
}

/**
 * Company the current action acts as. -1 means the local company; set from
 * the optional "company" request parameter for agent-vs-agent battles, where
 * an external controller drives companies owned by placeholder AIs.
 */
int g_action_company = -1;

/** The company actions act as: the battle-assigned company, or the local company. */
CompanyID ActionCompany()
{
	return g_action_company >= 0 ? CompanyID(g_action_company) : _local_company;
}

/** True when a game is running (not main menu / scenario editor). */
bool InNormalGame()
{
	return _game_mode == GameMode::Normal;
}

/** True when a game is running and the acting company is valid. */
bool HasLocalCompany()
{
	return InNormalGame() && Company::IsValidID(ActionCompany());
}

/** Read an integer JSON parameter, or std::nullopt when missing/not a number. */
std::optional<int> JsonInt(const nlohmann::json &json, std::string_view key)
{
	auto it = json.find(key);
	if (it == json.end() || !it->is_number()) return std::nullopt;
	return it->get<int>();
}

/** Read a string JSON parameter, or std::nullopt when missing/not a string. */
std::optional<std::string> JsonString(const nlohmann::json &json, std::string_view key)
{
	auto it = json.find(key);
	if (it == json.end() || !it->is_string()) return std::nullopt;
	return it->get<std::string>();
}

/**
 * Validate map coordinates read from a request.
 * @param x The x coordinate.
 * @param y The y coordinate.
 * @return Error message when out of bounds, std::nullopt when valid.
 */
std::optional<std::string> ValidateCoords(int x, int y)
{
	if (x < 0 || y < 0 || x >= static_cast<int>(Map::SizeX()) || y >= static_cast<int>(Map::SizeY())) {
		return "coordinates out of map bounds";
	}
	return std::nullopt;
}

/**
 * Format the failure of a command into a readable message.
 * @param res The (failed) command result. May carry a parameterised encoded message.
 * @return Human readable error text.
 */
std::string CommandErrorToString(CommandCost &res)
{
	if (!res.GetEncodedMessage().empty()) return res.GetEncodedMessage().GetDecodedString();
	if (res.GetErrorMessage() != INVALID_STRING_ID) return GetString(res.GetErrorMessage());
	return "command failed";
}

/**
 * Execute a game command as the local company, restoring the previous
 * current-company afterwards. Commands executed via Command<>::Do() bill
 * and authorise against _current_company, which is not guaranteed to be the
 * local company when called from the browser event loop.
 * @param func Lambda executing the command.
 * @return The command's return value.
 */
template <typename Tfunc>
auto DoAsLocalCompany(Tfunc &&func)
{
	CompanyID old_company = _current_company;
	_current_company = ActionCompany();
	auto res = func();
	_current_company = old_company;
	return res;
}

/**
 * Parse a diagonal direction name. Direction names follow screen orientation;
 * the corresponding tile offsets are: ne = (x-1, y), se = (x, y+1), sw = (x+1, y), nw = (x, y-1).
 * @param dir The direction name: "ne", "se", "sw" or "nw".
 * @return The direction, or std::nullopt for anything else.
 */
std::optional<DiagDirection> ParseDiagDirection(std::string_view dir)
{
	if (dir == "ne") return DiagDirection::NE;
	if (dir == "se") return DiagDirection::SE;
	if (dir == "sw") return DiagDirection::SW;
	if (dir == "nw") return DiagDirection::NW;
	return std::nullopt;
}

/** Look up a cargo type by (case-insensitive) display name, e.g. "coal" or "passengers". */
std::optional<CargoType> FindCargoTypeByName(std::string_view name)
{
	std::string needle = ToLower(name);
	for (const CargoSpec *spec : CargoSpec::Iterate()) {
		if (ToLower(GetString(STR_JUST_CARGO_LIST, CargoTypes{spec->Index()})) == needle) return spec->Index();
	}
	return std::nullopt;
}

/** Get the display name of a cargo type. */
std::string CargoName(CargoType cargo)
{
	return GetString(STR_JUST_CARGO_LIST, CargoTypes{cargo});
}

/* Action: list engines currently available to the local company for a vehicle type. */
nlohmann::json ActionListEngines(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto type = JsonString(req, "vehicle_type");
	if (!type.has_value()) return ErrorResponse("missing parameter: vehicle_type");

	VehicleType vt;
	if (*type == "road") vt = VehicleType::Road;
	else if (*type == "rail") vt = VehicleType::Train;
	else if (*type == "ship") vt = VehicleType::Ship;
	else if (*type == "aircraft") vt = VehicleType::Aircraft;
	else return ErrorResponse("vehicle_type must be one of: road, rail, ship, aircraft");

	nlohmann::json engines = nlohmann::json::array();
	for (const Engine *e : Engine::IterateType(vt)) {
		if (!IsEngineBuildable(e->index, vt, ActionCompany())) continue;
		nlohmann::json je;
		je["id"] = e->index.base();
		je["name"] = GetString(STR_ENGINE_NAME, e->index);
		je["max_speed"] = e->GetDisplayMaxSpeed();
		je["capacity"] = e->GetDisplayDefaultCapacity();
		je["running_cost"] = static_cast<int64_t>(e->GetRunningCost());
		je["lifespan"] = e->info.lifelength.base();
		CargoType cargo = e->GetDefaultCargoType();
		if (cargo != INVALID_CARGO) je["cargo"] = CargoName(cargo);
		engines.push_back(std::move(je));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["engines"] = std::move(engines);
	return res;
}

/* Action: describe what is on a tile. */
nlohmann::json ActionQueryTile(const nlohmann::json &req)
{
	if (!InNormalGame()) return ErrorResponse("no active game");

	auto x = JsonInt(req, "x");
	auto y = JsonInt(req, "y");
	if (!x.has_value() || !y.has_value()) return ErrorResponse("missing parameters: x, y");
	if (auto err = ValidateCoords(*x, *y); err.has_value()) return ErrorResponse(*err);

	TileIndex tile = TileXY(*x, *y);

	nlohmann::json res;
	res["ok"] = true;
	res["x"] = *x;
	res["y"] = *y;

	switch (GetTileType(tile)) {
		case TileType::Clear:       res["type"] = "clear"; break;
		case TileType::Railway:     res["type"] = "rail"; res["owner"] = GetTileOwner(tile).base(); break;
		case TileType::Road:        res["type"] = "road"; res["owner"] = GetTileOwner(tile).base(); break;
		case TileType::House: {
			res["type"] = "town";
			const Town *town = Town::Get(GetTownIndex(tile));
			res["town_index"] = town->index.base();
			res["town_name"] = GetTownName(town);
			break;
		}
		case TileType::Trees:       res["type"] = "trees"; break;
		case TileType::Station: {
			res["type"] = "station";
			const Station *st = Station::GetByTile(tile);
			res["station_id"] = st->index.base();
			res["owner"] = st->owner.base();
			break;
		}
		case TileType::Water:       res["type"] = "water"; break;
		case TileType::Void:        res["type"] = "void"; break;
		case TileType::Industry: {
			res["type"] = "industry";
			const Industry *ind = Industry::Get(GetIndustryIndex(tile));
			res["industry_index"] = ind->index.base();
			res["industry_type"] = GetString(GetIndustrySpec(ind->type)->name);
			break;
		}
		case TileType::TunnelBridge: res["type"] = "tunnel_bridge"; break;
		case TileType::Object:      res["type"] = "object"; break;
		default:                    res["type"] = "unknown"; break;
	}
	return res;
}

/* Action: find a town by (case-insensitive) name. */
nlohmann::json ActionFindTown(const nlohmann::json &req)
{
	if (!InNormalGame()) return ErrorResponse("no active game");

	auto name = JsonString(req, "name");
	if (!name.has_value()) return ErrorResponse("missing parameter: name");

	std::string needle = ToLower(*name);
	const Town *substring_match = nullptr;
	for (const Town *town : Town::Iterate()) {
		std::string town_name = ToLower(GetTownName(town));
		if (town_name == needle) {
			nlohmann::json res;
			res["ok"] = true;
			res["index"] = town->index.base();
			res["x"] = TileX(town->xy);
			res["y"] = TileY(town->xy);
			res["population"] = town->cache.population;
			return res;
		}
		if (substring_match == nullptr && town_name.find(needle) != std::string::npos) substring_match = town;
	}

	if (substring_match != nullptr) {
		nlohmann::json res;
		res["ok"] = true;
		res["index"] = substring_match->index.base();
		res["x"] = TileX(substring_match->xy);
		res["y"] = TileY(substring_match->xy);
		res["population"] = substring_match->cache.population;
		return res;
	}
	return ErrorResponse("town not found");
}

/* Action: find industries near a point, optionally filtered by produced/accepted cargo. */
nlohmann::json ActionFindIndustries(const nlohmann::json &req)
{
	if (!InNormalGame()) return ErrorResponse("no active game");

	auto x = JsonInt(req, "x");
	auto y = JsonInt(req, "y");
	auto radius = JsonInt(req, "radius");
	if (!x.has_value() || !y.has_value() || !radius.has_value()) return ErrorResponse("missing parameters: x, y, radius");
	if (auto err = ValidateCoords(*x, *y); err.has_value()) return ErrorResponse(*err);
	if (*radius <= 0) return ErrorResponse("radius must be positive");

	std::optional<CargoType> wanted_cargo;
	if (auto cargo = JsonString(req, "cargo"); cargo.has_value()) {
		wanted_cargo = FindCargoTypeByName(*cargo);
		if (!wanted_cargo.has_value()) return ErrorResponse("unknown cargo type");
	}

	TileIndex origin = TileXY(*x, *y);
	std::vector<std::pair<uint, const Industry *>> found;
	for (const Industry *ind : Industry::Iterate()) {
		if (wanted_cargo.has_value()) {
			const IndustrySpec *spec = GetIndustrySpec(ind->type);
			bool matches = std::find(spec->produced_cargo.begin(), spec->produced_cargo.end(), *wanted_cargo) != spec->produced_cargo.end() ||
					std::find(spec->accepts_cargo.begin(), spec->accepts_cargo.end(), *wanted_cargo) != spec->accepts_cargo.end();
			if (!matches) continue;
		}
		uint distance = DistanceManhattan(ind->location.tile, origin);
		if (distance > static_cast<uint>(*radius)) continue;
		found.emplace_back(distance, ind);
	}
	std::sort(found.begin(), found.end(), [](const auto &a, const auto &b) { return a.first < b.first; });

	nlohmann::json industries = nlohmann::json::array();
	for (size_t i = 0; i < std::min<size_t>(10, found.size()); i++) {
		const Industry *ind = found[i].second;
		nlohmann::json ji;
		ji["index"] = ind->index.base();
		ji["type"] = GetString(GetIndustrySpec(ind->type)->name);
		ji["x"] = TileX(ind->location.tile);
		ji["y"] = TileY(ind->location.tile);
		ji["distance"] = found[i].first;
		industries.push_back(std::move(ji));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["industries"] = std::move(industries);
	return res;
}

/* Action: build normal road between two tiles in an L-shape (first along X, then along Y). */
nlohmann::json ActionBuildRoad(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto x1 = JsonInt(req, "x1");
	auto y1 = JsonInt(req, "y1");
	auto x2 = JsonInt(req, "x2");
	auto y2 = JsonInt(req, "y2");
	if (!x1.has_value() || !y1.has_value() || !x2.has_value() || !y2.has_value()) return ErrorResponse("missing parameters: x1, y1, x2, y2");
	if (auto err = ValidateCoords(*x1, *y1); err.has_value()) return ErrorResponse(*err);
	if (auto err = ValidateCoords(*x2, *y2); err.has_value()) return ErrorResponse(*err);

	/* L-shaped path: along X at y1, then along Y at x2. */
	struct RoadStep {
		TileIndex tile;
		RoadBits bits;
	};
	std::vector<RoadStep> path;
	int dx = (*x2 >= *x1) ? 1 : -1;
	for (int x = *x1; ; x += dx) {
		path.push_back({TileXY(x, *y1), ROAD_X});
		if (x == *x2 || path.size() > 4096) break;
	}
	if (*y1 != *y2) {
		int dy = (*y2 >= *y1) ? 1 : -1;
		for (int y = *y1 + dy; ; y += dy) {
			path.push_back({TileXY(*x2, y), ROAD_Y});
			if (y == *y2 || path.size() > 4096) break;
		}
	}

	if (path.size() > 2048) return ErrorResponse("road path too long");

	uint tiles_built = 0;
	uint tiles_skipped = 0;
	Money total_cost = 0;
	for (const RoadStep &step : path) {
		/* Skip tiles that already carry (at least) the road bits we want. */
		if (IsTileType(step.tile, TileType::Road) && IsNormalRoadTile(step.tile) &&
				GetAnyRoadBits(step.tile, RoadTramType::Road).All(step.bits)) {
			tiles_skipped++;
			continue;
		}

		CommandCost cost;
		try {
			cost = DoAsLocalCompany([&]() {
				return Command<Commands::BuildRoad>::Do({DoCommandFlag::Execute, DoCommandFlag::Auto, DoCommandFlag::NoWater},
					step.tile, step.bits, ROADTYPE_ROAD, DisallowedRoadDirections{}, TownID::Invalid());
			});
		} catch (const std::exception &e) {
			nlohmann::json res;
			res["ok"] = false;
			res["error"] = std::string("command threw: ") + e.what();
			res["tiles_built"] = tiles_built;
			res["failed_tile"]["x"] = TileX(step.tile);
			res["failed_tile"]["y"] = TileY(step.tile);
			return res;
		}

		if (cost.Failed()) {
			/* Depots, stations and crossings already occupying the tile are fine to drive through. */
			if (cost.GetErrorMessage() == STR_ERROR_ALREADY_BUILT) {
				tiles_skipped++;
				continue;
			}
			nlohmann::json res;
			res["ok"] = false;
			res["error"] = CommandErrorToString(cost);
			res["tiles_built"] = tiles_built;
			res["tiles_skipped"] = tiles_skipped;
			res["cost"] = static_cast<int64_t>(total_cost);
			res["failed_tile"]["x"] = TileX(step.tile);
			res["failed_tile"]["y"] = TileY(step.tile);
			return res;
		}
		tiles_built++;
		total_cost += cost.GetCost();
	}

	nlohmann::json res;
	res["ok"] = true;
	res["tiles_built"] = tiles_built;
	res["tiles_skipped"] = tiles_skipped;
	res["cost"] = static_cast<int64_t>(total_cost);
	return res;
}

/* Action: build a bay road stop. The stop entrance faces the given direction; the connecting road must be adjacent there. */
nlohmann::json ActionBuildRoadStop(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto x = JsonInt(req, "x");
	auto y = JsonInt(req, "y");
	if (!x.has_value() || !y.has_value()) return ErrorResponse("missing parameters: x, y");
	if (auto err = ValidateCoords(*x, *y); err.has_value()) return ErrorResponse(*err);

	auto dir = JsonString(req, "direction");
	auto ddir = dir.has_value() ? ParseDiagDirection(*dir) : std::nullopt;
	if (!ddir.has_value()) return ErrorResponse("direction must be one of: ne, nw, se, sw");

	bool truck = req.value("truck", true);
	TileIndex tile = TileXY(*x, *y);

	CommandCost cost = DoAsLocalCompany([&]() {
		return Command<Commands::BuildRoadStop>::Do({DoCommandFlag::Execute, DoCommandFlag::Auto, DoCommandFlag::NoWater},
			tile, 1, 1, truck ? RoadStopType::Truck : RoadStopType::Bus, false, *ddir,
			ROADTYPE_ROAD, ROADSTOP_CLASS_DFLT, 0, StationID::Invalid(), false);
	});

	if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));

	const Station *st = Station::GetByTile(tile);
	nlohmann::json res;
	res["ok"] = true;
	res["station_id"] = st != nullptr ? static_cast<int>(st->index.base()) : -1;
	res["cost"] = static_cast<int64_t>(cost.GetCost());
	return res;
}

/* Action: build a road depot. The depot entrance faces the given direction; the connecting road must be adjacent there. */
nlohmann::json ActionBuildDepot(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto x = JsonInt(req, "x");
	auto y = JsonInt(req, "y");
	if (!x.has_value() || !y.has_value()) return ErrorResponse("missing parameters: x, y");
	if (auto err = ValidateCoords(*x, *y); err.has_value()) return ErrorResponse(*err);

	auto dir = JsonString(req, "direction");
	auto ddir = dir.has_value() ? ParseDiagDirection(*dir) : std::nullopt;
	if (!ddir.has_value()) return ErrorResponse("direction must be one of: ne, nw, se, sw");

	TileIndex tile = TileXY(*x, *y);

	CommandCost cost = DoAsLocalCompany([&]() {
		return Command<Commands::BuildRoadDepot>::Do({DoCommandFlag::Execute, DoCommandFlag::Auto, DoCommandFlag::NoWater},
			tile, ROADTYPE_ROAD, *ddir);
	});

	if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));

	nlohmann::json res;
	res["ok"] = true;
	res["depot_x"] = *x;
	res["depot_y"] = *y;
	res["cost"] = static_cast<int64_t>(cost.GetCost());
	return res;
}

/* Action: buy a vehicle in the depot on a tile. */
nlohmann::json ActionBuyVehicle(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto depot_x = JsonInt(req, "depot_x");
	auto depot_y = JsonInt(req, "depot_y");
	auto engine_id = JsonInt(req, "engine_id");
	if (!depot_x.has_value() || !depot_y.has_value() || !engine_id.has_value()) return ErrorResponse("missing parameters: depot_x, depot_y, engine_id");
	if (auto err = ValidateCoords(*depot_x, *depot_y); err.has_value()) return ErrorResponse(*err);
	if (*engine_id < 0) return ErrorResponse("invalid engine_id");

	EngineID eid(*engine_id);
	if (Engine::GetIfValid(eid) == nullptr) return ErrorResponse("unknown engine_id");

	auto [cost, veh_id, refit_capacity, refit_mail, cargo_capacities] = DoAsLocalCompany([&]() {
		return Command<Commands::BuildVehicle>::Do({DoCommandFlag::Execute},
			TileXY(*depot_x, *depot_y), eid, true, INVALID_CARGO, ClientID::Invalid);
	});

	if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));

	nlohmann::json res;
	res["ok"] = true;
	res["vehicle_id"] = veh_id.base();
	res["cost"] = static_cast<int64_t>(cost.GetCost());
	return res;
}

/* Action: append a go-to-station order to a vehicle's order list. */
nlohmann::json ActionAddOrder(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	auto vehicle_id = JsonInt(req, "vehicle_id");
	auto station_id = JsonInt(req, "station_id");
	auto station_x = JsonInt(req, "station_x");
	auto station_y = JsonInt(req, "station_y");
	if (!vehicle_id.has_value() || (!station_id.has_value() && (!station_x.has_value() || !station_y.has_value()))) return ErrorResponse("missing parameters: vehicle_id, station_id (or station_x, station_y)");
	if (station_x.has_value() && station_y.has_value()) {
		if (auto err = ValidateCoords(*station_x, *station_y); err.has_value()) return ErrorResponse(*err);
	}
	if (*vehicle_id < 0) return ErrorResponse("invalid vehicle_id");

	VehicleID vid(*vehicle_id);
	const Vehicle *v = Vehicle::GetIfValid(vid);
	if (v == nullptr || !v->IsPrimaryVehicle()) return ErrorResponse("unknown vehicle_id");
	if (v->owner != ActionCompany()) return ErrorResponse("vehicle is not owned by the acting company");

	StationID sid = StationID::Invalid();
	if (station_id.has_value()) {
		sid = StationID(*station_id);
		if (!Station::IsValidID(sid)) return ErrorResponse("unknown station_id");
	} else {
		TileIndex tile = TileXY(*station_x, *station_y);
		if (!IsTileType(tile, TileType::Station)) return ErrorResponse("no station at the given tile");
		sid = GetStationIndex(tile);
	}

	Order order;
	order.MakeGoToStation(sid);
	/* NearEnd (the default) and Middle stop locations are train-only; road
	 * vehicles must stop at the far end. */
	order.SetStopLocation(OrderStopLocation::FarEnd);

	auto order_type = JsonString(req, "order_type").value_or("goto");
	if (order_type == "full_load") {
		order.SetLoadType(OrderLoadType::FullLoad);
	} else if (order_type != "goto") {
		return ErrorResponse("order_type must be one of: goto, full_load");
	}

	CommandCost cost = DoAsLocalCompany([&]() {
		return Command<Commands::InsertOrder>::Do({DoCommandFlag::Execute}, vid, v->GetNumOrders(), order);
	});

	if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));

	nlohmann::json res;
	res["ok"] = true;
	res["order_count"] = v->GetNumOrders();
	return res;
}

/**
 * Shared helper for vehicle actions: resolve and validate a local company vehicle.
 * @return The vehicle, or nullptr (and sets err) on failure.
 */
const Vehicle *ResolveLocalVehicle(const nlohmann::json &req, nlohmann::json &err)
{
	auto vehicle_id = JsonInt(req, "vehicle_id");
	if (!vehicle_id.has_value() || *vehicle_id < 0) {
		err = ErrorResponse("missing or invalid parameter: vehicle_id");
		return nullptr;
	}
	VehicleID vid(*vehicle_id);
	const Vehicle *v = Vehicle::GetIfValid(vid);
	if (v == nullptr || !v->IsPrimaryVehicle()) {
		err = ErrorResponse("unknown vehicle_id");
		return nullptr;
	}
	if (v->owner != ActionCompany()) {
		err = ErrorResponse("vehicle is not owned by the acting company");
		return nullptr;
	}
	return v;
}

/* Action: start a vehicle (no-op when already running). */
nlohmann::json ActionStartVehicle(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	nlohmann::json err;
	const Vehicle *v = ResolveLocalVehicle(req, err);
	if (v == nullptr) return err;

	if (v->vehstatus.Test(VehState::Stopped)) {
		/* Commands::StartStopVehicle toggles the stopped state. */
		CommandCost cost = DoAsLocalCompany([&]() {
			return Command<Commands::StartStopVehicle>::Do({DoCommandFlag::Execute}, v->index, false);
		});
		if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["vehicle_id"] = v->index.base();
	return res;
}

/* Action: stop a vehicle (no-op when already stopped). */
nlohmann::json ActionStopVehicle(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	nlohmann::json err;
	const Vehicle *v = ResolveLocalVehicle(req, err);
	if (v == nullptr) return err;

	if (!v->vehstatus.Test(VehState::Stopped)) {
		/* Commands::StartStopVehicle toggles the stopped state. */
		CommandCost cost = DoAsLocalCompany([&]() {
			return Command<Commands::StartStopVehicle>::Do({DoCommandFlag::Execute}, v->index, false);
		});
		if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["vehicle_id"] = v->index.base();
	return res;
}

/* Action: sell a vehicle; it must be stopped inside a depot. */
nlohmann::json ActionSellVehicle(const nlohmann::json &req)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	nlohmann::json err;
	const Vehicle *v = ResolveLocalVehicle(req, err);
	if (v == nullptr) return err;

	CommandCost cost = DoAsLocalCompany([&]() {
		return Command<Commands::SellVehicle>::Do({DoCommandFlag::Execute}, v->index, false, false, ClientID::Invalid);
	});

	if (cost.Failed()) return ErrorResponse(CommandErrorToString(cost));

	nlohmann::json res;
	res["ok"] = true;
	res["income"] = static_cast<int64_t>(-cost.GetCost());
	return res;
}

/* Action: list the local company's road vehicles. */
nlohmann::json ActionListVehicles(const nlohmann::json &)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	nlohmann::json vehicles = nlohmann::json::array();
	for (const Vehicle *v : Vehicle::Iterate()) {
		if (v->type != VehicleType::Road || !v->IsPrimaryVehicle()) continue;
		if (v->owner != ActionCompany()) continue;

		nlohmann::json jv;
		jv["id"] = v->index.base();
		jv["engine_name"] = GetString(STR_ENGINE_NAME, v->engine_type);
		if (v->IsStoppedInDepot()) {
			jv["state"] = "in depot";
		} else if (v->vehstatus.Test(VehState::Stopped)) {
			jv["state"] = "stopped";
		} else {
			jv["state"] = "running";
		}
		jv["profit_last_year"] = static_cast<int64_t>(v->GetDisplayProfitLastYear());
		jv["order_count"] = static_cast<int>(v->GetNumOrders());
		vehicles.push_back(std::move(jv));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["vehicles"] = std::move(vehicles);
	return res;
}

/* Action: list the local company's stations. */
nlohmann::json ActionListStations(const nlohmann::json &)
{
	if (!HasLocalCompany()) return ErrorResponse("no active game with a local company");

	nlohmann::json stations = nlohmann::json::array();
	for (const Station *st : Station::Iterate()) {
		if (st->owner != ActionCompany()) continue;

		nlohmann::json js;
		js["id"] = st->index.base();
		js["name"] = GetString(STR_STATION_NAME, st->index);
		js["x"] = TileX(st->xy);
		js["y"] = TileY(st->xy);
		nlohmann::json facilities = nlohmann::json::array();
		if (st->facilities.Test(StationFacility::Train)) facilities.push_back("train");
		if (st->facilities.Test(StationFacility::TruckStop)) facilities.push_back("truck_stop");
		if (st->facilities.Test(StationFacility::BusStop)) facilities.push_back("bus_stop");
		if (st->facilities.Test(StationFacility::Airport)) facilities.push_back("airport");
		if (st->facilities.Test(StationFacility::Dock)) facilities.push_back("dock");
		js["facilities"] = std::move(facilities);
		stations.push_back(std::move(js));
	}

	nlohmann::json res;
	res["ok"] = true;
	res["stations"] = std::move(stations);
	return res;
}

}

extern "C" {

/**
 * Execute one gameplay action described by a JSON request.
 *
 * The returned pointer refers to a static buffer that is invalidated by the
 * next call; the Emscripten side is expected to copy it out (e.g. via
 * UTF8ToString) immediately. Not thread-safe, but the WASM build is
 * single-threaded.
 *
 * Request:  {"action": "<name>", ...params}
 * Result:   {"ok": true, ...info} or {"ok": false, "error": "..."}
 *
 * Supported actions: list_engines, query_tile, find_town, find_industries,
 * build_road, build_road_stop, build_depot, buy_vehicle, add_order,
 * start_vehicle, stop_vehicle, sell_vehicle, list_vehicles, list_stations.
 * The optional "company" parameter makes the action act as that company
 * (agent-vs-agent battles) instead of the local company.
 * @param json_request NUL-terminated UTF-8 JSON document.
 * @return Pointer to a NUL-terminated UTF-8 JSON document.
 */
const char *EMSCRIPTEN_KEEPALIVE em_openttd_action(const char *json_request)
{
	static std::string response;

	if (json_request == nullptr) {
		response = ErrorResponse("null request").dump();
		return response.c_str();
	}

	nlohmann::json req = nlohmann::json::parse(json_request, nullptr, false);
	if (req.is_discarded() || !req.is_object()) {
		response = ErrorResponse("invalid JSON request").dump();
		return response.c_str();
	}

	auto action = JsonString(req, "action");
	if (!action.has_value()) {
		response = ErrorResponse("missing parameter: action").dump();
		return response.c_str();
	}

	/* Optional "company": act as that company instead of the local one.
	 * Used by agent-vs-agent battles, where the browser controller drives
	 * companies owned by placeholder (RemoteControl) AIs. */
	g_action_company = -1;
	if (auto company = JsonInt(req, "company"); company.has_value()) {
		if (*company < 0 || !Company::IsValidID(CompanyID(*company))) {
			response = ErrorResponse("invalid company").dump();
			return response.c_str();
		}
		g_action_company = *company;
	}

	nlohmann::json res;
	try {
		if (*action == "list_engines") res = ActionListEngines(req);
		else if (*action == "query_tile") res = ActionQueryTile(req);
		else if (*action == "find_town") res = ActionFindTown(req);
		else if (*action == "find_industries") res = ActionFindIndustries(req);
		else if (*action == "build_road") res = ActionBuildRoad(req);
		else if (*action == "build_road_stop") res = ActionBuildRoadStop(req);
		else if (*action == "build_depot") res = ActionBuildDepot(req);
		else if (*action == "buy_vehicle") res = ActionBuyVehicle(req);
		else if (*action == "add_order") res = ActionAddOrder(req);
		else if (*action == "start_vehicle") res = ActionStartVehicle(req);
		else if (*action == "stop_vehicle") res = ActionStopVehicle(req);
		else if (*action == "sell_vehicle") res = ActionSellVehicle(req);
		else if (*action == "list_vehicles") res = ActionListVehicles(req);
		else if (*action == "list_stations") res = ActionListStations(req);
		else res = ErrorResponse("unknown action");
	} catch (const std::exception &e) {
		res = ErrorResponse(std::string("internal error: ") + e.what());
	} catch (...) {
		res = ErrorResponse("internal error");
	}

	g_action_company = -1;
	response = res.dump();
	return response.c_str();
}

}

#endif /* __EMSCRIPTEN__ */

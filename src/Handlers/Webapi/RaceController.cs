// File: src/handlers/webapi/RaceController.cs

using Microsoft.AspNetCore.Mvc;
using Nines.BackEnd.DTOs;
using Nines.BackEnd.Services;

namespace Nines.BackEnd.Handlers.WebAPI
{
    [ApiController]
    [Route("api/[controller]")]
    public class RaceController : ControllerBase
    {
        private readonly IRaceService _raceService;

        public RaceController(IRaceService raceService)
        {
            _raceService = raceService;
        }

        /// <summary>
        /// GET api/race/next
        /// Returns the very next scheduled race.
        /// </summary>
        [HttpGet("next")]
        public async Task<ActionResult<RaceDto>> GetNextRace()
        {
            var dto = await _raceService.GetNextRaceAsync();
            if (dto == null) return NotFound();
            return Ok(dto);
        }

        /// <summary>
        /// GET api/race/{id}
        /// Looks up a race by its integer ID.
        /// </summary>
        [HttpGet("{id:int}")]
        public async Task<ActionResult<RaceDto>> GetById(int id)
        {
            var dto = await _raceService.GetRaceByIdAsync(id);
            if (dto == null) return NotFound();
            return Ok(dto);
        }

        /// <summary>
        /// GET api/race
        /// Lists all upcoming races.
        /// </summary>
        [HttpGet]
        public async Task<ActionResult<IEnumerable<RaceDto>>> GetAllUpcoming()
        {
            var list = await _raceService.GetUpcomingRacesAsync();
            return Ok(list);
        }
    }
}

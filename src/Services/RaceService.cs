// File: src/Services/RaceService.cs
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Nines.BackEnd.Domains.Repositories;
using Nines.BackEnd.Domains.Entities;
using Nines.BackEnd.DTOs;

namespace Nines.BackEnd.Services
{
    /// <summary>
    /// Implements IRaceService by calling into the IRaceRepository
    /// and mapping domain Races → RaceDto.
    /// </summary>
    public class RaceService : IRaceService
    {
        private readonly IRaceRepository _repo;
        private readonly ILogger<RaceService> _logger;

        private int? _currentRaceId;

    public RaceService(IRaceRepository repo, ILogger<RaceService> logger)
    {
      _repo = repo;
      _logger = logger;
    }

        public async Task<RaceDto?> GetNextRaceAsync()
        {
            var race = await _repo.GetNextAsync();
            return race is null ? null : MapToDto(race);
        }

        public async Task<RaceDto?> GetRaceByIdAsync(int id)
        {
            var race = await _repo.GetByIdAsync(id);
            return race is null ? null : MapToDto(race);
        }

        public async Task<IEnumerable<RaceDto>> GetUpcomingRacesAsync()
        {
            var races = await _repo.GetUpcomingAsync();
            return races.Select(MapToDto);
        }
        
                /// <summary>Called every minute at :00 to open bets.</summary>

        public async Task OpenBetsAsync()
        {
            var race = await _repo.CreateNextRaceAsync();
            _logger.LogInformation(
                "Opened bets on Race {Id} at {Time}.",
                race.Id, race.StartTime);
        }

        /// <summary>Called every minute at :27 to close bets.</summary>
        public async Task CloseBetsAsync()
        {
            await _repo.CloseCurrentRaceAsync();
            _logger.LogInformation("Closed bets at UTC now: {Time}", DateTime.UtcNow);
        }

         public async Task StartRaceAsync()
    {
        // 1) flip status to InProgress
        await _repo.StartCurrentRaceAsync();

        // 2) simulate & complete it immediately
        var race = await _repo.RunCurrentRaceAsync();

        // 3) remember which race we just ran
        _currentRaceId = race.Id;

        _logger.LogInformation(
            "Race {RaceId} started & simulated at {Time}. Winner precomputed: Horse {WinnerId}",
            race.Id, DateTime.UtcNow, race.WinnerId);
    }

    public async Task EndRaceAsync()
    {
        if (_currentRaceId is null)
        {
            _logger.LogWarning("EndRaceAsync called before StartRaceAsync.");
            return;
        }

        // re-fetch the completed race
        var race = await _repo.GetByIdAsync(_currentRaceId.Value)
                 ?? throw new InvalidOperationException($"Race {_currentRaceId} not found");

        _logger.LogInformation(
            "Race {RaceId} ended at {Time}. Winner: Horse {WinnerId}.",
            race.Id, DateTime.UtcNow, race.WinnerId);
    }

        /// <summary>Called every minute at :59 to reset for the next cycle.</summary>
        public async Task ResetRaceAsync()
        {
          await _repo.ResetForNextCycleAsync();
          _logger.LogInformation("Cleared completed races at {Time}.", DateTime.UtcNow);
        }

        private static RaceDto MapToDto(Race r) => new RaceDto
    {
      Id = r.Id,
      StartTime = r.StartTime,
      Status = r.Status.ToString(),
      Horses = r.Horses.Select(h => new HorseSummaryDto
      {
        Id = h.Id,
        Name = h.Name,
        Odds = h.Odds
      }).ToList()
    };
    }
}

// File: src/Services/IRaceService.cs
using System.Collections.Generic;
using System.Threading.Tasks;
using Nines.BackEnd.DTOs;

namespace Nines.BackEnd.Services
{
    /// <summary>
    /// Contracts for querying Race data and projecting it into DTOs.
    /// </summary>
    public interface IRaceService
    {
        Task<RaceDto?> GetNextRaceAsync();
        Task<RaceDto?> GetRaceByIdAsync(int id);
        Task<IEnumerable<RaceDto>> GetUpcomingRacesAsync();
        // new methods for the scheduler:
        Task OpenBetsAsync();     // :00
        Task CloseBetsAsync();    // :27
        Task StartRaceAsync();    // :30  ← newly added
        Task EndRaceAsync();      // :50
        Task ResetRaceAsync();    // :59
    }
}

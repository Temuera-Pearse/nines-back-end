// File: src/Domains/Repositories/IRaceRepository.cs
using System.Collections.Generic;
using System.Threading.Tasks;
using Nines.BackEnd.Domains.Entities;

namespace Nines.BackEnd.Domains.Repositories
{
  public interface IRaceRepository
  {
    Task<Race?> GetByIdAsync(int id);
    Task<IEnumerable<Race>> GetUpcomingAsync();
    Task<Race?> GetNextAsync();
    Task AddAsync(Race race);
    Task UpdateAsync(Race race);
    Task DeleteAsync(int id);

    // new lifecycle operations:
    /// <summary>Creates the next race scheduled at the upcoming :30 mark.</summary>
    Task<Race> CreateNextRaceAsync();

    /// <summary>Closes bets on the race that’s currently OpenForBetting.</summary>
    Task CloseCurrentRaceAsync();

    /// <summary>Marks the race that’s BettingClosed as InProgress.</summary>
    Task StartCurrentRaceAsync();

        /// <summary>Runs the InProgress race: simulates finish, picks winner, sets Completed.</summary>
    Task<Race> RunCurrentRaceAsync();

    /// <summary>Clears out any Completed races so new ones can be created.</summary>
    Task ResetForNextCycleAsync();
    }
}

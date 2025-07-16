using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Nines.BackEnd.Data;
using Nines.BackEnd.Domains.Entities;

namespace Nines.BackEnd.Domains.Repositories
{
    public class EfRaceRepository : IRaceRepository
    {
        private readonly GameDbContext _db;
        private readonly Random        _rng = new();

        public EfRaceRepository(GameDbContext db)
        {
            _db = db;
        }

        // ── BASIC CRUD ───────────────────────────────────────────

        public async Task<Race?> GetByIdAsync(int id) =>
            await _db.Races
                     .Include(r => r.Participants)
                     .ThenInclude(rp => rp.Horse)
                     .FirstOrDefaultAsync(r => r.RaceId == id);

        public async Task<IEnumerable<Race>> GetUpcomingAsync() =>
            await _db.Races
                     .Where(r => r.ScheduledStartUtc > DateTime.UtcNow)
                     .OrderBy(r => r.ScheduledStartUtc)
                     .ToListAsync();

        public async Task<Race?> GetNextAsync() =>
            await _db.Races
                     .Where(r => r.ScheduledStartUtc > DateTime.UtcNow)
                     .OrderBy(r => r.ScheduledStartUtc)
                     .FirstOrDefaultAsync();

        public async Task AddAsync(Race race)
        {
            _db.Races.Add(race);
            await _db.SaveChangesAsync();
        }

        public async Task UpdateAsync(Race race)
        {
            _db.Races.Update(race);
            await _db.SaveChangesAsync();
        }

        public async Task DeleteAsync(int id)
        {
            var race = await _db.Races.FindAsync(id);
            if (race != null)
            {
                _db.Races.Remove(race);
                await _db.SaveChangesAsync();
            }
        }

        // ── LIFECYCLE OPERATIONS ─────────────────────────────────

        public async Task<Race> CreateNextRaceAsync()
        {
            // 1) compute next :30 UTC
            var now    = DateTime.UtcNow;
            var next30 = new DateTime(
                now.Year, now.Month, now.Day,
                now.Hour, now.Minute, 30,
                DateTimeKind.Utc);
            if (now.Second >= 30) next30 = next30.AddMinutes(1);

            // 2) load fixed 10 horses
            var horses = await _db.Horses
                                  .OrderBy(h => h.HorseId)
                                  .Take(10)
                                  .ToListAsync();

            // 3) build Race + Participants
            var race = new Race
            {
                ScheduledStartUtc = next30,
                DurationSeconds   = 20,
                Status            = RaceStatus.OpenForBetting
            };
            // EF will insert race, then participants as children
            foreach (var h in horses)
            {
                race.Participants.Add(new RaceParticipant
                {
                    HorseId = h.HorseId,
                    OddsAtStart = null  // static for now
                });
            }

            _db.Races.Add(race);
            await _db.SaveChangesAsync();
            return race;
        }

        public async Task CloseCurrentRaceAsync()
        {
            var race = await _db.Races
                                .FirstOrDefaultAsync(r => r.Status == RaceStatus.OpenForBetting);
            if (race != null)
            {
                race.Status = RaceStatus.BettingClosed;
                await _db.SaveChangesAsync();
            }
        }

        public async Task StartCurrentRaceAsync()
        {
            var race = await _db.Races
                                .FirstOrDefaultAsync(r => r.Status == RaceStatus.BettingClosed);
            if (race != null)
            {
                race.Status = RaceStatus.InProgress;
                await _db.SaveChangesAsync();
            }
        }

        public async Task<Race> RunCurrentRaceAsync()
        {
            var race = await _db.Races
                                .Include(r => r.Participants)
                                .FirstOrDefaultAsync(r => r.Status == RaceStatus.InProgress)
                     ?? throw new InvalidOperationException("No in-progress race");

            // pick random winner
            var parts     = race.Participants;
            var winnerIdx = _rng.Next(parts.Count);
            var winner    = parts[winnerIdx];

            // winner time 80–100% of nominal duration
            var baseDur   = race.DurationSeconds;
            var winnerTime = baseDur * (0.8 + 0.2 * _rng.NextDouble());
            winner.FinishTimeSeconds = Math.Round(winnerTime, 2);
            winner.FinishPosition    = 1;

            // other finishers
            var finishList = new List<RaceParticipant> { winner };
            foreach (var p in parts.Where(p => p != winner)
                                   .OrderBy(_ => _rng.Next()))
            {
                var delay   = 0.1 + _rng.NextDouble() * ((baseDur + 1) - (winnerTime + 0.1));
                p.FinishTimeSeconds   = Math.Round(winnerTime + delay, 2);
                p.FinishPosition      = null; // assign next
                finishList.Add(p);
            }

            // assign positions 2..N
            int pos = 2;
            foreach (var p in finishList.OrderBy(p => p.FinishTimeSeconds))
                p.FinishPosition = pos++;

            race.WinnerHorseId = winner.HorseId;
            race.Status        = RaceStatus.Completed;

            await _db.SaveChangesAsync();
            return race;
        }

        public async Task ResetForNextCycleAsync()
        {
            // delete all completed races & their participants
            var done = _db.Races.Where(r => r.Status == RaceStatus.Completed);
            _db.Races.RemoveRange(done);
            await _db.SaveChangesAsync();
        }
    }
}

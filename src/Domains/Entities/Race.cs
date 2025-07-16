using System;
using System.Collections.Generic;           // for List<T>

namespace Nines.BackEnd.Domains.Entities
{
  public enum RaceStatus {
    Scheduled,       // created but bets not yet open
    OpenForBetting,  // bets are being accepted
    BettingClosed,   // bets locked in, about to start
    InProgress,      // race is running
    Completed        // race finished 
  }

  public class Race
  {
    public int    RaceId           { get; set; }
    public DateTime ScheduledStartUtc { get; set; }
    public RaceStatus Status { get; set; }
    public double DurationSeconds { get; set; }
    
    public int?      WinnerHorseId      { get; set; }

    public List<RaceParticipant> Participants { get; set; } = new();

    // Now Horse is in scope because it's in the same namespace:
    public List<Horse> Horses { get; set; } = new();

    // optional, for later phases:
    public int? WinnerId { get; set; }
    
    public List<FinishTime> FinishTimes { get; set; } = new();
  }
}


// src/DTOs/RaceDto.cs
using System;
using System.Collections.Generic;

namespace Nines.BackEnd.DTOs
{
  /// <summary>
  /// A Data Transfer Object representing a Race in API responses.
  /// </summary>
  public class RaceDto
  {
    /// <summary>
    /// The unique ID of the race.
    /// </summary>
    public int Id { get; set; }

    /// <summary>
    /// When the race is scheduled to start (UTC).
    /// </summary>
    public DateTime StartTime { get; set; }

    /// <summary>
    /// The current status (Scheduled, InProgress, Completed).
    /// </summary>
    public string Status { get; set; } = default!;

    /// <summary>
    /// The list of competing horses (id, name, odds).
    /// </summary>
    public List<HorseSummaryDto> Horses { get; set; } = new();

    public int? WinnerId { get; set; }
    public List<FinishTimeDto>? FinishTimes { get; set; }
    
    
    }
}
